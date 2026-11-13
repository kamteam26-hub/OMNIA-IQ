// Sections still being moved from the v88.5 desktop app into the cloud version.
import { json, fail } from '../http.js';
import { all } from '../db.js';
import * as llm from '../llm.js';
const later = (what, stage) => fail(503, `${what} is being moved into the cloud version (stage ${stage}) and will be available soon.`);
export async function assistantRoutes(method, parts, b, url) {
  const p = parts.slice(1).join('/');
  if (p === 'models') { const ready = await llm.readyProviders(); return json({ models: ready.map(r => ({ id: r.id, name: r.name, model: r.model, tools: true, kind: 'cloud' })) }); }
  if (p === 'tools' || p.startsWith('runs') || p.startsWith('workspace')) { const { agentRoutes } = await import('./agent.js'); return agentRoutes(method, parts, b, url); }
  if (p === 'browser/status') return json({ connected: false, clients: [] });
  if (p === 'ollama') return json({ installed: [], available: false, note: 'Local Ollama models run only in the desktop version. Use Ollama Cloud in Settings → AI providers.' });
  if (p.startsWith('ollama/')) return fail(400, 'Local Ollama models run only in the desktop version. Use Ollama Cloud in Settings → AI providers.');
  return later('Agent mode', 3);
}
export async function projectsStub(method, parts, url) {
  if (parts.length === 1 && method === 'GET') return json({ tasks: (await all('SELECT * FROM tasks ORDER BY id DESC LIMIT 100')).map(t => ({ ...t, events: [], artifacts: [] })) });
  if (parts[1] === 'studios') return json({ studios: [] });
  return later('The upgraded Video Studio and projects', 2);
}
export const agentStudioStub = () => later('Agent Studio', 3);
export const automationStub = () => later('Automation', 3);
export const publishingStub = () => later('Publishing', 3);
export const launchStub = () => fail(403, 'Launch Center is not needed in the cloud version: OMNIA IQ is already live on Vercel.');
