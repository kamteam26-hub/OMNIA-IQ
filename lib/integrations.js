// API-key integrations from v88.5 Settings: web search (Tavily, Brave), Pexels, Freesound, ElevenLabs.
import * as settings from './settings.js';
import { mask } from './http.js';

export const KEYS = { tavily: 'TAVILY_API_KEY', brave: 'OMNIA_WEB_SEARCH_API_KEY', pexels: 'PEXELS_API_KEY', freesound: 'FREESOUND_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };
export const SECRET_KEYS = Object.values(KEYS);

export async function keyStatus(name) {
  const v = await settings.get(KEYS[name]);
  return { configured: !!v, masked_key: mask(v), env_file: 'OMNIA cloud settings (encrypted)' };
}
export async function saveKey(name, value) {
  const v = String(value || '').trim();
  if (/\s/.test(v)) throw Object.assign(new Error('API key cannot contain spaces or line breaks.'), { status: 400 });
  await settings.set({ [KEYS[name]]: v }, { secret: [KEYS[name]] });
  return keyStatus(name);
}

async function timed(url, init = {}, ms = 20000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

// ---------------- web search
export async function webStatus() {
  const tavily = await keyStatus('tavily'), brave = await keyStatus('brave');
  return { configured: tavily.configured || brave.configured, active: tavily.configured ? 'tavily' : brave.configured ? 'brave' : null, env_file: tavily.env_file,
    providers: [{ id: 'tavily', name: 'Tavily', ...tavily }, { id: 'brave', name: 'Brave Search', ...brave }] };
}
export async function webSearch(query, max = 6) {
  const tavily = await settings.get(KEYS.tavily), brave = await settings.get(KEYS.brave);
  if (tavily) {
    const r = await timed('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: tavily, query, max_results: max, include_answer: false }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Tavily (${r.status}): ${d.detail?.error || d.error || 'request failed'}`);
    return (d.results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 600) }));
  }
  if (brave) {
    const r = await timed('https://api.search.brave.com/res/v1/web/search?count=' + max + '&q=' + encodeURIComponent(query), { headers: { accept: 'application/json', 'X-Subscription-Token': brave } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Brave (${r.status}): request failed`);
    return (d.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.description || '').replace(/<[^>]+>/g, '').slice(0, 600) }));
  }
  throw new Error('No web search provider configured. Add a free Tavily or Brave key in Settings.');
}
export async function testWeb(name) {
  const key = await settings.get(KEYS[name]);
  if (!key) return { ok: false, configured: false, message: 'Not configured.' };
  try { const res = await webSearch('OMNIA IQ test query', 1); return { ok: true, configured: true, message: `Search works (${res.length} result).` }; }
  catch (e) { return { ok: false, configured: true, message: e.message }; }
}

// ---------------- media keys
export async function testPexels() {
  const key = await settings.get(KEYS.pexels); if (!key) return { ok: false, configured: false, message: 'Not configured.' };
  const r = await timed('https://api.pexels.com/videos/search?per_page=1&query=city', { headers: { authorization: key } });
  return r.ok ? { ok: true, configured: true, message: 'Pexels key works.' } : { ok: false, configured: true, message: `Pexels returned ${r.status}.` };
}
export async function testFreesound() {
  const key = await settings.get(KEYS.freesound); if (!key) return { ok: false, configured: false, message: 'Not configured.' };
  const r = await timed('https://freesound.org/apiv2/search/text/?query=rain&page_size=1&token=' + encodeURIComponent(key));
  return r.ok ? { ok: true, configured: true, message: 'Freesound key works.' } : { ok: false, configured: true, message: `Freesound returned ${r.status}.` };
}
export async function elevenStatus() {
  const s = await settings.getMany(['ELEVENLABS_VOICE_ID', 'ELEVENLABS_MALE_VOICE_ID', 'ELEVENLABS_FEMALE_VOICE_ID', 'ELEVENLABS_MODEL']);
  return { ...(await keyStatus('elevenlabs')), default_voice: s.ELEVENLABS_VOICE_ID, male_voice: s.ELEVENLABS_MALE_VOICE_ID, female_voice: s.ELEVENLABS_FEMALE_VOICE_ID, model: s.ELEVENLABS_MODEL || 'eleven_multilingual_v2' };
}
export async function saveEleven(b) {
  const updates = { ELEVENLABS_VOICE_ID: b.default_voice ?? b.voice_id ?? '', ELEVENLABS_MALE_VOICE_ID: b.male_voice ?? '', ELEVENLABS_FEMALE_VOICE_ID: b.female_voice ?? '', ELEVENLABS_MODEL: b.model ?? '' };
  if (b.api_key) updates.ELEVENLABS_API_KEY = String(b.api_key).trim();
  await settings.set(updates, { secret: ['ELEVENLABS_API_KEY'] });
  return elevenStatus();
}
export async function elevenVoices() {
  const key = await settings.get(KEYS.elevenlabs); if (!key) throw Object.assign(new Error('Add your ElevenLabs API key first.'), { status: 400 });
  const r = await timed('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`ElevenLabs returned ${r.status}`), { status: 502 });
  return { voices: (d.voices || []).map(v => ({ voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels })) };
}
