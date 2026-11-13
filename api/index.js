// OMNIA IQ v88.5 — cloud backend entry point (Vercel).
import { json, fail, body } from '../lib/http.js';
import { denied } from '../lib/auth.js';
import { bindRequest } from '../lib/llm.js';
import { systemRoutes } from '../lib/routes/system.js';
import { chatRoutes } from '../lib/routes/chat.js';
import { filesRoutes } from '../lib/routes/files.js';
import { memoryRoutes } from '../lib/routes/memory.js';
import { assistantRoutes, projectsStub, agentStudioStub, automationStub, publishingStub, launchStub } from '../lib/routes/stubs.js';

async function route(request, url, path) {
  const parts = path.split('/').filter(Boolean), method = request.method;
  const b = await body(request);
  switch (parts[0]) {
    case 'system': return systemRoutes(method, parts, b, url, request);
    case 'chat': return chatRoutes(method, parts, b, url, request);
    case 'files': return filesRoutes(method, parts, b, url, request);
    case 'memory': return memoryRoutes(method, parts, b, url, request);
    case 'assistant': return assistantRoutes(method, parts, b, url, request);
    case 'projects': {
      try { const m = await import('../lib/routes/projects.js'); return m.projectsRoutes(method, parts, b, url, request); }
      catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return projectsStub(method, parts, url); }
    }
    case 'agent-studio': return agentStudioStub();
    case 'automation': return automationStub();
    case 'publishing': return publishingStub();
    case 'launch': return launchStub();
  }
  return null;
}

async function handle(request) {
  const url = new URL(request.url);
  const path = (url.searchParams.get('__p') ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  url.searchParams.delete('__p');
  bindRequest(request);
  const why = denied(request, path);
  if (why) return fail(401, why);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin && !origin.startsWith('chrome-extension://')) return fail(403, 'Cross-origin mutation denied');
  }
  try { return (await route(request, url, path)) || fail(404, `Unknown endpoint: /api/${path}`); }
  catch (e) { console.error(e); return fail(e.status || 500, e.message || 'Server error'); }
}
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
