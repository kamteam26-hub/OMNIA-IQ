// Long-term memory (port of v88.5 database memory functions).
import { all, one, run } from './db.js';
import { ownerId, useQuota } from './auth.js';
const words = s => new Set((String(s || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || []));

export async function addMemory(content, kind = 'knowledge', importance = 1, source = 'conversation') {
  content = String(content || '').trim(); if (!content) return null;
  const row = await one('SELECT id FROM memories WHERE content=? AND owner_id=?', [content, ownerId()]);
  if (row) { await run('UPDATE memories SET importance=MAX(importance,?),updated_at=CURRENT_TIMESTAMP WHERE id=?', [importance, row.id]); return row.id; }
  return (await run('INSERT INTO memories(kind,content,importance,source,owner_id) VALUES (?,?,?,?,?)', [kind, content, importance, source, ownerId()])).lastId;
}
export const listMemories = (limit = 200) => all('SELECT * FROM memories WHERE owner_id=? ORDER BY importance DESC, updated_at DESC LIMIT ?', [ownerId(), limit]);
export const memoryStats = async () => one('SELECT COUNT(*) c, COALESCE(SUM(LENGTH(content)),0) chars FROM memories WHERE owner_id=?', [ownerId()]);
export async function relevantMemories(query, limit = 8, kind = null, requireOverlap = true) {
  const terms = words(query);
  const rows = kind ? await all('SELECT * FROM memories WHERE kind=? AND owner_id=? ORDER BY importance DESC, updated_at DESC LIMIT 1000', [kind, ownerId()]) : await all("SELECT * FROM memories WHERE kind!='conversation' AND owner_id=? ORDER BY importance DESC, updated_at DESC LIMIT 1000", [ownerId()]);
  return rows.map(d => { const w = words(d.content); let s = 0; for (const t of terms) if (w.has(t)) s += 5; return [s + Number(d.importance), d, s]; })
    .filter(([, , s]) => s > 0 || !terms.size || !requireOverlap).sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}
export async function searchMemories(query, limit = 30, kind = null) {
  limit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const terms = [...words(query)].slice(0, 16);
  if (!terms.length) return (await listMemories(limit)).filter(m => !kind || m.kind === kind);
  const where = terms.map(() => 'lower(content) LIKE ?').join(' OR ');
  const rows = await all(`SELECT * FROM memories WHERE owner_id=? AND (${where})${kind ? ' AND kind=?' : ''} LIMIT 500`, [ownerId(), ...terms.map(t => `%${t}%`), ...(kind ? [kind] : [])]);
  return rows.map(r => [terms.filter(t => r.content.toLowerCase().includes(t)).length * 10 + Number(r.importance), r]).sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}
export async function updateMemory(id, content, kind, importance) {
  content = String(content || '').trim();
  if (!content || content.length > 20000) throw Object.assign(new Error('Memory content must contain 1–20000 characters'), { status: 422 });
  const prev = await one('SELECT * FROM memories WHERE id=? AND owner_id=?', [id, ownerId()]); if (!prev) return false;
  const imp = importance ?? prev.importance; if (imp < 1 || imp > 5) throw Object.assign(new Error('Importance must be between 1 and 5'), { status: 422 });
  await run('UPDATE memories SET content=?,kind=?,importance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [content, kind ?? prev.kind, imp, id]);
  await run('INSERT INTO memory_changes(memory_id,operation,old_content,new_content) VALUES(?,?,?,?)', [id, 'update', prev.content, content]);
  return true;
}
export async function deleteMemory(id) {
  const row = await one('SELECT content FROM memories WHERE id=? AND owner_id=?', [id, ownerId()]);
  if (row) { await run('INSERT INTO memory_changes(memory_id,operation,old_content,new_content) VALUES(?,?,?,NULL)', [id, 'delete', row.content]); await run('DELETE FROM memories WHERE id=?', [id]); }
}
export const memoryHistory = id => all('SELECT c.* FROM memory_changes c WHERE c.memory_id=? AND EXISTS(SELECT 1 FROM memories m WHERE m.id=c.memory_id AND m.owner_id=?) ORDER BY c.id DESC LIMIT 100', [id, ownerId()]);
