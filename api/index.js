// OMNIA IQ v88.5 — cloud backend entry point (Vercel).
import { json, fail, body } from '../lib/http.js';
import { ensureAuth, sessionUser, isPublic, adminOnly, rateLimit, withUser, audit, clientIp, setupRequired } from '../lib/auth.js';
import { bindRequest } from '../lib/llm.js';
let waitUntil = p => p;
try { ({ waitUntil } = await import('@vercel/functions')); } catch {}
import { systemRoutes } from '../lib/routes/system.js';
import { chatRoutes } from '../lib/routes/chat.js';
import { filesRoutes } from '../lib/routes/files.js';
import { memoryRoutes } from '../lib/routes/memory.js';
import { assistantRoutes, projectsStub, agentStudioStub, automationStub, publishingStub, launchStub } from '../lib/routes/stubs.js';

async function route(request, url, path) {
  const parts = path.split('/').filter(Boolean), method = request.method;
  const b = await body(request);
  switch (parts[0]) {
    case 'auth': { const m = await import('../lib/routes/account.js'); return m.accountRoutes(method, parts, b, url, request); }
    case 'admin': { const m = await import('../lib/routes/admin.js'); return m.adminRoutes(method, parts, b, url, request); }
    case 'system': return systemRoutes(method, parts, b, url, request);
    case 'chat': return chatRoutes(method, parts, b, url, request);
    case 'files': return filesRoutes(method, parts, b, url, request);
    case 'memory': return memoryRoutes(method, parts, b, url, request);
    case 'assistant': return assistantRoutes(method, parts, b, url, request);
    case 'projects': {
      try { const m = await import('../lib/routes/projects.js'); return m.projectsRoutes(method, parts, b, url, request); }
      catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return projectsStub(method, parts, url); }
    }
    case 'agent-studio': { const m = await import('../lib/routes/agent_studio.js'); return m.agentStudioRoutes(method, parts, b, url, request); }
    case 'automation': { const m = await import('../lib/routes/automation.js'); return m.automationRoutes(method, parts, b, url, request); }
    case 'publishing': { const m = await import('../lib/routes/publishing.js'); return m.publishingRoutes(method, parts, b, url, request); }
    case 'launch': return launchStub();
  }
  return null;
}

async function handle(request) {
  const url = new URL(request.url);
  const path = (url.searchParams.get('__p') ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  url.searchParams.delete('__p');
  bindRequest(request);
  await ensureAuth();
  const user = await sessionUser(request);
  if (!isPublic(path)) {
    if (!user) return fail(401, (await setupRequired()) ? 'setup required' : 'Sign in required');
    if (user.must_change_password && !path.startsWith('auth/') && path !== 'system/status') return fail(403, 'Change your password before continuing.');
    if (adminOnly(request.method, path) && user.role !== 'admin') { await audit(user, 'forbidden', { method: request.method, path, status: 403, ip: clientIp(request) }); return fail(403, 'Administrator access required.'); }
    const limited = await rateLimit(user); if (limited) return fail(429, limited);
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin && !origin.startsWith('chrome-extension://')) return fail(403, 'Cross-origin mutation denied');
  }
  return withUser(user, () => dispatch(request, url, path, user));
}
async function dispatch(request, url, path, user) {
  try {
    const res = (await route(request, url, path)) || fail(404, `Unknown endpoint: /api/${path}`);
    // v88.5 automation: every successful change emits a section event, then due work runs in the background.
    const section = { projects: 'tasks', publishing: 'publishing', chat: 'chat', files: 'files', memory: 'memory', system: 'settings' }[path.split('/')[0]];
    if (section && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && res.status < 300) {
      waitUntil((async () => { const a = await import('../lib/routes/automation.js'); await a.emit(section, `${path.split('/')[0]}.${request.method.toLowerCase()}`, { method: request.method, path: '/api/' + path }); await a.tick(); })().catch(e => console.error('automation', e)));
    }
    if (user && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !path.startsWith('auth/') && path !== 'automation/tick')
      waitUntil(audit(user, 'change', { method: request.method, path: '/api/' + path, status: res.status, ip: clientIp(request) }));
    return res;
  }
  catch (e) { if (!e.status || e.status >= 500) console.error(e); return fail(e.status || 500, e.message || 'Server error'); }
}
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
