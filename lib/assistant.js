// OMNIA IQ assistant (port of v88.5 services/ai/assistant.ask): conversation-aware chat with memory,
// attached files, optional web search and the multi-model "analytical council" (harmony).
import { all, one, run } from './db.js';
import * as llm from './llm.js';
import { webSearch } from './integrations.js';
import { relevantMemories } from './memory.js';

export const PERSONA = `You are OMNIA IQ, an adaptive AI workspace and production studio created by KAM Team.
Reason carefully, write clearly and complete the work end to end. Use attached files and web sources when given, and cite web sources as markdown links.
Be direct and practical. Never invent facts, links or results; say plainly when you are unsure.`;

const ROLES = {
  reasoner: 'Analyse the request rigorously: goals, constraints, risks and the best approach.',
  analyst: 'Check facts, numbers and assumptions; point out anything uncertain.',
  generalist: 'Give a complete, practical answer.',
  planner: 'Turn the request into a concrete step-by-step plan.',
  researcher: 'Bring in relevant knowledge, examples and sources.',
  critic: 'Find weaknesses in the obvious answer and fix them.',
  verifier: 'Verify the answer is correct and complete.',
};

export async function loadFiles(ids = []) {
  const out = [];
  for (const id of ids.slice(0, 10)) {
    const row = await one('SELECT filename, mime_type, size_bytes, extracted_text, local_file_id FROM uploads WHERE local_file_id=? OR CAST(id AS TEXT)=? ORDER BY id DESC LIMIT 1', [String(id), String(id)]);
    if (row) out.push(row);
  }
  return out;
}
function userContent(text, files, web) {
  let full = text;
  for (const f of files) full += f.extracted_text ? `\n\n[Attached file: ${f.filename}]\n${f.extracted_text}` : `\n\n[Attached file: ${f.filename} (${f.mime_type}, ${f.size_bytes} bytes) — binary content cannot be read as text.]`;
  if (web?.length) full += '\n\n[Web search results]\n' + web.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n${r.snippet}`).join('\n\n');
  return full;
}

export async function ask({ message, useWeb = false, fileIds = [], harmony = false, conversationId = null }) {
  const conv = conversationId ? await one('SELECT instructions FROM conversations WHERE id=?', [conversationId]) : null;
  const history = conversationId ? (await all('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 12', [conversationId])).reverse() : [];
  const [mems, files] = await Promise.all([relevantMemories(message, 6), loadFiles(fileIds)]);
  let web = [], web_error = '';
  if (useWeb) { try { web = await webSearch(message, 6); } catch (e) { web_error = e.message; } }
  let system = PERSONA;
  if (conv?.instructions) system += `\n\nInstructions for this conversation:\n${conv.instructions}`;
  if (mems.length) system += `\n\nLong-term memory that may be relevant:\n${mems.map(m => `- (${m.kind}) ${m.content}`).join('\n')}`;
  const convo = [{ role: 'system', content: system }, ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })), { role: 'user', content: userContent(message, files, web) }];

  let reply, providers_used;
  if (harmony) {
    const ready = (await llm.readyProviders()).slice(0, 3);
    const specialists = ready.length > 1 ? ready : [ready[0], ready[0], ready[0]].filter(Boolean).map((p, i) => ({ ...p, role: ['reasoner', 'analyst', 'critic'][i] }));
    if (!specialists.length) await llm.chat(convo); // raises the clear "no provider" error
    const drafts = await Promise.all(specialists.map(p => llm.chat([{ role: 'system', content: `${system}\n\nYou are the ${p.role} specialist. ${ROLES[p.role] || ROLES.generalist} Be concise.` }, ...convo.slice(1)], { providers: [p], maxTokens: 1500 })
      .then(r => ({ name: `${p.name} (${p.role})`, text: r.text })).catch(e => ({ name: `${p.name} (${p.role})`, text: `(unavailable: ${e.message})` }))));
    const final = await llm.chat([{ role: 'system', content: `${system}\n\nYou are the OMNIA conductor. Merge the specialist drafts into one excellent final answer. Resolve disagreements, keep what is correct, and do not mention the specialists.` },
      { role: 'user', content: `User request:\n${message}\n\nSpecialist drafts:\n${drafts.map(d => `### ${d.name}\n${d.text}`).join('\n\n')}` }]);
    reply = final.text; providers_used = [...drafts.map(d => d.name), `${final.provider.name} (conductor)`];
  } else {
    const r = await llm.chat(convo);
    reply = r.text; providers_used = [`${r.provider.name} (${r.provider.model})`];
  }
  return { reply, providers_used, web_used: web.length > 0, web_sources: web.map(({ title, url }) => ({ title, url })), web_error };
}

export async function addMessage(role, content, conversationId) {
  let cid = conversationId;
  if (!cid || !(await one('SELECT id FROM conversations WHERE id=?', [cid]))) cid = (await run(`INSERT INTO conversations(title) VALUES ('New conversation')`)).lastId;
  await run('INSERT INTO messages(conversation_id,role,content) VALUES (?,?,?)', [cid, role, content]);
  await run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [cid]);
  if (role === 'user') {
    const row = await one('SELECT title FROM conversations WHERE id=?', [cid]);
    if (row && (row.title === 'New conversation' || !row.title)) await run('UPDATE conversations SET title=? WHERE id=?', [content.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation', cid]);
  }
  return cid;
}
