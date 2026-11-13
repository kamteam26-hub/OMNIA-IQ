import { json, fail } from '../http.js';
import { all, one, run } from '../db.js';
import { ask, addMessage } from '../assistant.js';
import { addMemory } from '../memory.js';
export async function chatRoutes(method, parts, b, url) {
  const [, a, id, sub] = parts; // chat / conversations / :id / sub
  if (!a && method === 'POST') {
    const message = String(b.message || '').trim(); if (!message) return fail(422, 'Message is empty');
    let cid = b.conversation_id || (await run(`INSERT INTO conversations(title) VALUES ('New conversation')`)).lastId;
    const result = await ask({ message, useWeb: !!b.use_web, fileIds: b.file_ids || [], harmony: !!b.harmony, conversationId: cid });
    cid = await addMessage('user', message, cid); await addMessage('assistant', result.reply, cid);
    const m = message.match(/^(?:please\s+)?remember(?:\s+that)?[:\s]+(.{5,})/i); if (m) await addMemory(m[1], 'knowledge', 4, 'chat');
    return json({ ...result, conversation_id: cid });
  }
  if (a === 'history') {
    const cid = url.searchParams.get('conversation_id');
    if (method === 'GET') { const rows = cid ? await all('SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 200', [Number(cid)]) : await all('SELECT id,role,content FROM messages ORDER BY id DESC LIMIT 200'); return json({ messages: rows.reverse() }); }
    if (method === 'DELETE') { cid ? await run('DELETE FROM messages WHERE conversation_id=?', [Number(cid)]) : await run('DELETE FROM messages'); return json({ ok: true }); }
  }
  if (a !== 'conversations') return null;
  if (!id && method === 'GET') return json({ conversations: await all(`SELECT c.id,c.title,c.instructions,c.created_at,c.updated_at,(SELECT content FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message FROM conversations c ORDER BY c.updated_at DESC, c.id DESC`) });
  if (!id && method === 'POST') return json({ id: (await run('INSERT INTO conversations(title) VALUES (?)', [String(b.title || 'New conversation').trim().slice(0, 200) || 'New conversation'])).lastId });
  if (id === 'search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q) return chatRoutes('GET', ['chat', 'conversations'], b, url);
    const t = `%${q}%`;
    return json({ conversations: await all('SELECT DISTINCT c.id,c.title,c.updated_at FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id WHERE lower(c.title) LIKE ? OR lower(m.content) LIKE ? ORDER BY c.updated_at DESC LIMIT 40', [t, t]) });
  }
  const cid = Number(id);
  if (!sub && method === 'GET') { const r = await one('SELECT id,title,instructions FROM conversations WHERE id=?', [cid]); return r ? json(r) : fail(404, 'Conversation not found'); }
  if (!sub && method === 'PATCH') { const t = String(b.title || '').trim(); if (!t) return fail(422, 'Title required'); await run('UPDATE conversations SET title=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [t.slice(0, 200), cid]); return json({ ok: true }); }
  if (!sub && method === 'DELETE') { await run('DELETE FROM messages WHERE conversation_id=?', [cid]); await run('DELETE FROM conversations WHERE id=?', [cid]); return json({ ok: true }); }
  if (sub === 'instructions' && method === 'PUT') { const r = await run('UPDATE conversations SET instructions=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [String(b.instructions || '').slice(0, 8000), cid]); return r.changes ? json({ ok: true }) : fail(404, 'Conversation not found'); }
  if (sub === 'fork' && method === 'POST') {
    const old = await one('SELECT title,instructions FROM conversations WHERE id=?', [cid]); if (!old) return fail(404, 'Conversation or message not found');
    const through = b.through_message_id ?? null;
    if (through != null && !(await one('SELECT 1 x FROM messages WHERE conversation_id=? AND id=?', [cid, through]))) return fail(404, 'Conversation or message not found');
    const nid = (await run('INSERT INTO conversations(title,instructions) VALUES (?,?)', [old.title.slice(0, 180) + ' (branch)', old.instructions])).lastId;
    const msgs = await all('SELECT role,content FROM messages WHERE conversation_id=?' + (through != null ? ' AND id<=?' : '') + ' ORDER BY id', through != null ? [cid, through] : [cid]);
    for (const m of msgs) await run('INSERT INTO messages(conversation_id,role,content) VALUES (?,?,?)', [nid, m.role, m.content]);
    return json({ id: nid });
  }
  return null;
}
