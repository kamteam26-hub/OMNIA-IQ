import { json, fail } from '../http.js';
import * as M from '../memory.js';
const MAX_PRINCIPLE = 280;
export async function memoryRoutes(method, parts, b, url) {
  const [, id, sub] = parts; // ['memory', id?, sub?]
  if (!id && method === 'GET') return json({ memories: await M.listMemories(), stats: await M.memoryStats() });
  if (!id && method === 'POST') {
    const content = String(b.content || '').trim(); if (!content) return fail(422, 'Memory is empty');
    if (b.kind === 'principle' && content.length > MAX_PRINCIPLE) return fail(422, `A creative principle should be one or two sentences (${MAX_PRINCIPLE} characters or fewer). Yours is ${content.length}.`);
    return json({ id: await M.addMemory(content, b.kind || 'knowledge', Number(b.importance) || 2, 'manual') });
  }
  if (id === 'search') return json({ memories: await M.searchMemories(url.searchParams.get('query') || '', url.searchParams.get('limit') || 30, url.searchParams.get('kind')) });
  if (id && sub === 'history') return json({ changes: await M.memoryHistory(Number(id)) });
  if (id && method === 'DELETE') { await M.deleteMemory(Number(id)); return json({ ok: true }); }
  if (id && method === 'PUT') { if (!(await M.updateMemory(Number(id), b.content, b.kind, b.importance))) return fail(404, 'Memory not found'); return json({ ok: true }); }
  return null;
}
