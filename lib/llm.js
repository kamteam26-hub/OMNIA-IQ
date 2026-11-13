// OMNIA IQ model providers (port of v88.5 llm_config + assistant provider specs), cloud-only.
// Every provider speaks the OpenAI chat-completions protocol. Keys live in the settings table.
import * as settings from './settings.js';
import { mask } from './http.js';

export const PROVIDERS = [
  { id: 'vercel_gateway', name: 'Vercel AI Gateway', key: 'AI_GATEWAY_API_KEY', modelKey: 'AI_GATEWAY_MODEL', model: 'google/gemini-2.5-flash', base: 'https://ai-gateway.vercel.sh/v1', role: 'generalist', priority: 120, signup: 'https://vercel.com/docs/ai-gateway', note: 'Built into Vercel: works without a key once a card is on file (free monthly credits).', oidc: true },
  { id: 'groq', name: 'Groq', key: 'GROQ_API_KEY', modelKey: 'GROQ_MODEL', model: 'llama-3.3-70b-versatile', base: 'https://api.groq.com/openai/v1', role: 'generalist', priority: 108, signup: 'https://console.groq.com/keys', note: 'Free tier, very fast inference. Function calling supported.' },
  { id: 'cerebras', name: 'Cerebras', key: 'CEREBRAS_API_KEY', modelKey: 'CEREBRAS_MODEL', model: 'gpt-oss-120b', base: 'https://api.cerebras.ai/v1', role: 'reasoner', priority: 107, signup: 'https://cloud.cerebras.ai', note: 'Free tier with a generous daily token allowance. Function calling supported.' },
  { id: 'gemini', name: 'Google Gemini', key: 'GEMINI_API_KEY', modelKey: 'GEMINI_MODEL', model: 'gemini-2.5-flash', base: 'https://generativelanguage.googleapis.com/v1beta/openai', role: 'analyst', priority: 106, signup: 'https://aistudio.google.com/apikey', note: 'Free tier in Google AI Studio.' },
  { id: 'ollama_cloud', name: 'Ollama Cloud', key: 'OLLAMA_API_KEY', modelKey: 'OLLAMA_CLOUD_MODEL', model: 'gpt-oss:120b', base: 'https://ollama.com/v1', role: 'reasoner', priority: 112, signup: 'https://ollama.com/settings/keys', note: 'Free account key. Runs large open models on Ollama\'s servers with tool calling.' },
  { id: 'openrouter', name: 'OpenRouter', key: 'OPENROUTER_API_KEY', modelKey: 'OPENROUTER_MODEL', model: 'openrouter/free', base: 'https://openrouter.ai/api/v1', role: 'reasoner', priority: 110, signup: 'https://openrouter.ai/keys', note: 'Free models end in :free (e.g. openai/gpt-oss-120b:free).' },
  { id: 'github_models', name: 'GitHub Models', key: 'GITHUB_MODELS_TOKEN', modelKey: 'GITHUB_MODELS_MODEL', model: 'openai/gpt-4.1-mini', base: 'https://models.github.ai/inference', role: 'analyst', priority: 104, signup: 'https://github.com/settings/personal-access-tokens', note: 'Free with a GitHub account: use a fine-grained token with the Models permission.' },
  { id: 'nvidia', name: 'NVIDIA NIM', key: 'NVIDIA_API_KEY', modelKey: 'NVIDIA_MODEL', model: 'meta/llama-3.3-70b-instruct', base: 'https://integrate.api.nvidia.com/v1', role: 'researcher', priority: 98, signup: 'https://build.nvidia.com', note: 'Free developer access at build.nvidia.com.' },
  { id: 'sambanova', name: 'SambaNova', key: 'SAMBANOVA_API_KEY', modelKey: 'SAMBANOVA_MODEL', model: 'Meta-Llama-3.3-70B-Instruct', base: 'https://api.sambanova.ai/v1', role: 'planner', priority: 94, signup: 'https://cloud.sambanova.ai', note: 'Trial credit on sign-up; check current terms.' },
  { id: 'mistral', name: 'Mistral', key: 'MISTRAL_API_KEY', modelKey: 'MISTRAL_MODEL', model: 'mistral-small-latest', base: 'https://api.mistral.ai/v1', role: 'critic', priority: 92, signup: 'https://console.mistral.ai/api-keys', note: 'Free Experiment tier.' },
  { id: 'huggingface', name: 'Hugging Face', key: 'HUGGINGFACE_API_KEY', modelKey: 'HUGGINGFACE_MODEL', model: 'openai/gpt-oss-120b:fastest', base: 'https://router.huggingface.co/v1', role: 'verifier', priority: 90, signup: 'https://huggingface.co/settings/tokens', note: 'Free monthly inference credits.' },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', key: 'CLOUDFLARE_API_TOKEN', modelKey: 'CLOUDFLARE_MODEL', model: '@cf/openai/gpt-oss-120b', base: '', role: 'planner', priority: 88, signup: 'https://dash.cloudflare.com/profile/api-tokens', note: 'Free daily allowance on Workers AI.', extra: [{ name: 'account_id', key: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', secret: false }] },
];
const byId = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));
export const SECRET_KEYS = PROVIDERS.map(p => p.key);

let currentRequest = null;
export const bindRequest = r => { currentRequest = r; };
const oidcToken = () => currentRequest?.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN || '';

async function resolve(p) {
  const key = (await settings.get(p.key)) || (p.oidc ? oidcToken() : '');
  const model = (await settings.get(p.modelKey)) || p.model;
  const extras = {};
  for (const f of p.extra || []) extras[f.name] = await settings.get(f.key);
  const disabled = (await settings.get(p.id.toUpperCase() + '_DISABLED')) === 'true';
  let base = p.base;
  if (p.id === 'cloudflare') base = extras.account_id ? `https://api.cloudflare.com/client/v4/accounts/${extras.account_id}/ai/v1` : '';
  const ready = !disabled && !!key && !!base && (p.extra || []).every(f => extras[f.name]);
  return { ...p, apiKey: key, model, base, extras, ready, viaOidc: p.oidc && !(await settings.get(p.key)) && !!key };
}
export async function resolved() { return Promise.all(PROVIDERS.map(resolve)); }
export async function readyProviders() { return (await resolved()).filter(p => p.ready).sort((a, b) => b.priority - a.priority); }

export async function providerStatus() {
  const list = await resolved(), ready = list.filter(p => p.ready);
  return {
    ready: ready.length > 0, multi_api: ready.length > 1, orchestrator: true, free_only: true,
    providers: list.map(p => ({ name: p.name, id: p.id, ready: p.ready, model: p.model, kind: 'cloud', role: p.role, capabilities: ['tools'], tools: true })),
    configured_count: ready.length, cloud_configured_count: ready.length, local_configured_count: 0,
    harmony_limit: 3, orchestration_mode: 'full',
  };
}
export async function modelLabel() {
  const ready = await readyProviders();
  return ready.length ? ready.map(p => `${p.model} (${p.role})`).join(' + ') : 'No LLM provider ready';
}
export async function configStatus() {
  const providers = [];
  for (const p of await resolved()) {
    const stored = await settings.get(p.key);
    const extra_fields = Object.fromEntries((p.extra || []).map(f => [f.name, { label: f.label, configured: !!p.extras[f.name], value: f.secret ? '' : p.extras[f.name] || '', masked: f.secret ? mask(p.extras[f.name]) : '' }]));
    providers.push({ id: p.id, name: p.name, configured: p.ready, masked_key: stored ? mask(stored) : (p.viaOidc ? 'automatic (Vercel)' : ''), model: p.model, extra_fields, signup: p.signup, note: p.note, env_file: 'OMNIA cloud settings (encrypted)' });
  }
  return { env_file: 'OMNIA cloud settings (encrypted)', env_exists: true, providers };
}
export async function saveProvider(id, apiKey, model, extra = {}) {
  const p = byId[id]; if (!p) throw Object.assign(new Error('Unknown LLM provider'), { status: 400 });
  const key = String(apiKey || '').trim().replace(/^['"]|['"]$/g, '');
  if (/\s/.test(key)) throw Object.assign(new Error(`${p.name} API key/token cannot contain spaces or line breaks.`), { status: 400 });
  const updates = { [p.key]: key, [p.modelKey]: String(model || '').trim() };
  if (p.oidc) updates[p.id.toUpperCase() + '_DISABLED'] = '';
  for (const f of p.extra || []) updates[f.key] = String(extra[f.name] || '').trim();
  await settings.set(updates, { secret: [p.key] });
  return (await configStatus()).providers.find(x => x.id === id);
}

export async function complete(p, messages, { maxTokens = 4000, temperature = 0.4, tools, timeoutMs = 120000 } = {}) {
  const body = { model: p.model, messages, max_tokens: maxTokens, temperature };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(p.base.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', signal: ctrl.signal, headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p.name} (${r.status}): ${(d.error?.message || d.message || JSON.stringify(d)).slice(0, 300)}`);
    return d.choices?.[0]?.message || { content: '' };
  } finally { clearTimeout(timer); }
}

// Try providers in priority order until one answers.
export async function chat(messages, opts = {}) {
  if (process.env.OMNIA_MOCK_LLM) return mock(messages, opts);
  const ready = opts.providers || await readyProviders();
  if (!ready.length) throw Object.assign(new Error('No AI provider is connected. Open Settings → AI providers and add a free key (Groq, Gemini, Cerebras, OpenRouter…), or add a card in Vercel to use the built-in AI Gateway.'), { status: 503 });
  const errors = [];
  for (const p of ready) {
    try { const m = await complete(p, messages, opts); return { text: (m.content || '').trim(), message: m, provider: p }; }
    catch (e) { errors.push(e.message); }
  }
  throw Object.assign(new Error('Every AI provider failed: ' + errors.join(' | ')), { status: 502 });
}
function mock(messages, opts = {}) {
  if (opts.tools && !messages.some(m => m.role === 'tool')) return { text: '', message: { content: 'I will write the file.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.md', content: '# Notes\nhello' }) } }, { id: 'c2', type: 'function', function: { name: 'memory_search', arguments: '{"query":"brand"}' } }] }, provider: { name: 'Mock', model: 'mock', id: 'mock' } };
  const last = messages.at(-1); const text = typeof last.content === 'string' ? last.content : last.content?.[0]?.text || '';
  return { text: `MOCK:${text.slice(0, 60)}`, message: { content: `MOCK:${text.slice(0, 60)}` }, provider: { name: 'Mock', model: 'mock', id: 'mock' } };
}
export async function testProvider(id) {
  const p = await resolve(byId[id] || {}); if (!byId[id]) throw Object.assign(new Error('Unknown LLM provider'), { status: 404 });
  if (!p.ready) return { ok: false, configured: false, message: `${p.name} is not fully configured.` };
  const t0 = Date.now();
  try { const m = await complete(p, [{ role: 'user', content: 'Reply with the single word: ready' }], { maxTokens: 20, timeoutMs: 30000 }); return { ok: true, configured: true, provider: p.name, model: p.model, latency_ms: Date.now() - t0, message: `${p.name} answered: ${(m.content || '').slice(0, 40)}` }; }
  catch (e) { return { ok: false, configured: true, provider: p.name, model: p.model, message: e.message }; }
}
