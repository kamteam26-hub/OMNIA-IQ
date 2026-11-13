// Agent mode (port of v88.5 agents/assistant_agent): a tool-using run with live steps that the chat polls.
// Runs are stored in the database so any serverless instance can report progress; the loop runs with waitUntil.
import { randomBytes } from 'node:crypto';
import { json, fail } from '../http.js';
import { all, one, run as exec } from '../db.js';
import { store } from '../storage.js';
import * as llm from '../llm.js';
import { webSearch } from '../integrations.js';
import { addMemory, searchMemories } from '../memory.js';
import { PERSONA, loadFiles, addMessage } from '../assistant.js';

let waitUntil = p => p;
try { ({ waitUntil } = await import('@vercel/functions')); } catch {}
const MAX_STEPS = 14, BUDGET_MS = 270000;

const TOOLS = [
  { name: 'web_search', description: 'Search the web for current information. Returns titles, URLs and snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'fetch_page', description: 'Read the text of a public web page.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'list_files', description: 'List files in this conversation\'s workspace.', parameters: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Read a workspace file or an attached file by name.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a text file (document, code, CSV, HTML, markdown) in the workspace so the user can download it.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'memory_search', description: 'Search OMNIA long-term memory.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'remember', description: 'Save a durable fact or preference the user asked OMNIA to remember.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
];
export const describeTools = () => ({ tools: TOOLS.map(t => ({ name: t.name, description: t.description })), code_execution: false, browser: { connected: false, clients: [] } });

const DDL = `CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, conversation_id INTEGER, state TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`;
let ddl; const ensure = () => (ddl ||= exec(DDL));
// A cancelled run is never overwritten by the still-running loop.
const save = r => exec(`INSERT INTO agent_runs(id,conversation_id,state,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=CURRENT_TIMESTAMP WHERE json_extract(agent_runs.state,'$.status')!='cancelled'`, [r.id, r.conversation_id, JSON.stringify(r)]);
const cleanName = pathname => pathname.split('/').slice(2).join('/').replace(/-[A-Za-z0-9]{20,}(\.[^./]+)?$|-\d{13,}(\.[^./]+)?$/, '$1$2');
async function wsFind(cid, p) { const want = String(p).replace(/^\/+/, ''); return (await store.list(`workspace/${cid}/`)).filter(b => cleanName(b.pathname) === want); }
const load = async id => { await ensure(); const row = await one('SELECT state FROM agent_runs WHERE id=?', [id]); return row ? JSON.parse(row.state) : null; };
const pub = r => { const keep = ['id', 'status', 'steps', 'reply', 'conversation_id', 'error', 'approval', 'sources', 'files', 'provider', 'created', 'finished', 'agent']; return Object.fromEntries(keep.map(k => [k, r[k] ?? null])); };

const wsPath = (cid, p) => `workspace/${cid}/${String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.+/g, '.').slice(0, 200)}`;
const htmlText = html => {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const body = html.replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return [title.trim(), body];
};
function publicUrl(u) {
  const x = new URL(u); if (!/^https?:$/.test(x.protocol) || x.username || x.password) throw new Error('Only public http(s) URLs can be fetched');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i.test(x.hostname)) throw new Error('Private, loopback and local-network addresses cannot be fetched');
  return x.toString();
}

async function tool(r, name, args, attached) {
  switch (name) {
    case 'web_search': { const res = await webSearch(String(args.query || ''), 6); res.forEach(x => r.sources.push({ title: x.title, url: x.url })); return res.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n') || 'No results.'; }
    case 'fetch_page': {
      const url = publicUrl(String(args.url || '')), c = new AbortController(), t = setTimeout(() => c.abort(), 20000);
      try {
        const res = await fetch(url, { signal: c.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (OMNIA IQ agent)', accept: 'text/html,text/plain,application/json' } });
        const text = (await res.text()).slice(0, 2_000_000); const [title, body] = /html/i.test(res.headers.get('content-type') || '') ? htmlText(text) : ['', text];
        r.sources.push({ title: title || url, url }); return `${title}\n${url}\n\n${body.slice(0, 15000)}`;
      } finally { clearTimeout(t); }
    }
    case 'list_files': { const files = (await store.list(`workspace/${r.conversation_id}/`)).map(b => cleanName(b.pathname)); return [...files, ...attached.map(f => `(attached) ${f.filename}`)].join('\n') || 'The workspace is empty.'; }
    case 'read_file': {
      const p = String(args.path || ''); const att = attached.find(f => f.filename === p || p.endsWith(f.filename));
      if (att) return att.extracted_text || `${att.filename} is a binary file (${att.mime_type}).`;
      const b = (await wsFind(r.conversation_id, p)).at(-1); if (!b) throw new Error('File not found');
      return (await store.read(b.url)).toString('utf8').slice(0, 30000);
    }
    case 'write_file': {
      const p = String(args.path || 'output.txt').replace(/^\/+/, ''); const content = String(args.content ?? '');
      for (const old of await wsFind(r.conversation_id, p)) await store.del([old.url]);
      await store.put(wsPath(r.conversation_id, p), content, /\.html?$/.test(p) ? 'text/html' : /\.json$/.test(p) ? 'application/json' : /\.csv$/.test(p) ? 'text/csv' : 'text/plain');
      r.files.push(p); return `Saved ${p} (${content.length} characters). The user can download it from the chat.`;
    }
    case 'memory_search': return (await searchMemories(String(args.query || ''), 8)).map(m => `- (${m.kind}) ${m.content}`).join('\n') || 'No matching memories.';
    case 'remember': await addMemory(String(args.content || ''), 'knowledge', 3, 'agent'); return 'Saved to memory.';
  }
  throw new Error(`Unknown tool ${name}`);
}

async function loop(r, message, fileIds, useWeb, modelId) {
  const started = Date.now();
  try {
    const attached = await loadFiles(fileIds);
    const history = (await all('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 10', [r.conversation_id])).reverse();
    const conv = await one('SELECT instructions FROM conversations WHERE id=?', [r.conversation_id]);
    let providers = await llm.readyProviders();
    if (modelId) providers = [...providers.filter(p => p.id === modelId), ...providers.filter(p => p.id !== modelId)];
    if (process.env.OMNIA_MOCK_LLM && !providers.length) providers = [{ id: 'mock', name: 'Mock', model: 'mock' }];
    if (!providers.length) throw new Error('No AI provider is connected. Open Settings → AI providers and add a free key.');
    const tools = TOOLS.filter(t => useWeb || !['web_search', 'fetch_page'].includes(t.name)).map(t => ({ type: 'function', function: t }));
    const sys = `${PERSONA}\n\nYou are in Agent mode. Use tools when they help: search and read pages for anything current, write files when the user wants a document, code or data they can download. Work step by step, then give a complete final answer in markdown with sources linked.${conv?.instructions ? `\n\nInstructions for this conversation:\n${conv.instructions}` : ''}`;
    const attachNote = attached.length ? `\n\n[Attached files: ${attached.map(f => f.filename).join(', ')} — use read_file to read them.]` : '';
    const msgs = [{ role: 'system', content: sys }, ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })), { role: 'user', content: message + attachNote }];
    for (let step = 0; step < MAX_STEPS; step++) {
      if ((await load(r.id))?.status === 'cancelled') return;
      if (Date.now() - started > BUDGET_MS) { msgs.push({ role: 'user', content: 'Time is almost up. Give your best final answer now without calling tools.' }); }
      r.steps = r.steps.filter(s => s.kind !== 'thinking'); r.steps.push({ kind: 'thinking', label: step ? 'Working on the next step' : 'Planning', time: Date.now() / 1000 }); await save(r);
      let res, lastErr;
      for (const p of providers) { try { res = await llm.chat(msgs, { providers: [p], tools: Date.now() - started > BUDGET_MS ? undefined : tools, maxTokens: 4000, temperature: 0.3 }); r.provider = `${p.name} · ${p.model}`; break; } catch (e) { lastErr = e; } }
      if (!res) throw lastErr;
      const m = res.message; r.steps = r.steps.filter(s => s.kind !== 'thinking');
      if (!m.tool_calls?.length) { r.reply = (m.content || '').trim() || 'Done.'; break; }
      msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      for (const call of m.tool_calls) {
        let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        const s = { kind: 'tool', tool: call.function.name, arguments: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, k === 'content' ? `${String(v).length} characters` : v])), status: 'running', thought: (m.content || '').slice(0, 300), time: Date.now() / 1000 };
        r.steps.push(s); await save(r);
        let out;
        try { out = await tool(r, call.function.name, args, attached); s.status = 'done'; s.preview = String(out).slice(0, 200); }
        catch (e) { out = `Error: ${e.message}`; s.status = 'error'; s.preview = e.message; }
        msgs.push({ role: 'tool', tool_call_id: call.id, content: String(out).slice(0, 20000) });
        await save(r);
      }
    }
    if (!r.reply) r.reply = 'I reached the step limit before finishing. Here is what I found so far:\n\n' + r.steps.filter(s => s.kind === 'tool').map(s => `- ${s.tool}: ${s.preview || ''}`).join('\n');
    r.status = 'completed';
    await addMessage('assistant', r.reply, r.conversation_id);
  } catch (e) { r.status = 'failed'; r.error = e.message; r.steps = r.steps.filter(s => s.kind !== 'thinking'); }
  finally { r.finished = Date.now() / 1000; const cur = await load(r.id); if (cur?.status === 'cancelled') { r.status = 'cancelled'; } await save(r); }
}

export async function agentRoutes(method, parts, b, url) {
  await ensure();
  const [, a, id, sub] = parts;
  if (a === 'tools') return json(describeTools());
  if (a === 'runs' && !id && method === 'POST') {
    const message = String(b.message || '').trim(); if (!message) return fail(422, 'Message is empty');
    const cid = await addMessage('user', message, b.conversation_id || null);
    const r = { id: randomBytes(12).toString('hex'), status: 'running', steps: [], reply: '', conversation_id: cid, error: '', approval: null, sources: [], files: [], provider: '', created: Date.now() / 1000, finished: null, agent: b.custom_agent_id || null };
    await save(r);
    waitUntil(loop(r, message, b.file_ids || [], b.use_web !== false, b.model_id || ''));
    return json(pub(r));
  }
  if (a === 'runs' && id && !sub) { const r = await load(id); return r ? json(pub(r)) : fail(404, 'Run not found (it may have expired)'); }
  if (a === 'runs' && sub === 'cancel') { const r = await load(id); if (!r) return fail(404, 'Run not found'); if (r.status === 'running') { r.status = 'cancelled'; r.finished = Date.now() / 1000; await exec('UPDATE agent_runs SET state=? WHERE id=?', [JSON.stringify(r), r.id]); } return json(pub(r)); }
  if (a === 'runs' && sub === 'approval') return fail(409, 'Nothing is waiting for approval');
  if (a === 'workspace' && id) {
    if (sub === 'file') {
      const p = url.searchParams.get('path') || ''; const b2 = (await wsFind(id, p)).at(-1); if (!b2) return fail(404, 'File not found');
      return new Response(await store.read(b2.url), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${p.split('/').pop().replace(/"/g, '')}"` } });
    }
    return json({ files: (await store.list(`workspace/${id}/`)).map(x => ({ path: cleanName(x.pathname), size: x.size })) });
  }
  return null;
}
