import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, fail } from '../http.js';
import { all, run, dbKind } from '../db.js';
import * as settings from '../settings.js';
import * as llm from '../llm.js';
import * as I from '../integrations.js';
import { store } from '../storage.js';
import { currentUser, setupRequired } from '../auth.js';
import { ffmpegPath } from '../media.js';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const load = f => JSON.parse(readFileSync(join(STATIC, f), 'utf8'));
export const VERSION = '88.5-cloud';

async function mediaStatus() {
  const ff = await ffmpegPath(), pex = await I.keyStatus('pexels'), fs = await I.keyStatus('freesound');
  return { ready: !!ff, install_supported: false, ffmpeg: { ready: !!ff, version: ff ? 'Bundled FFmpeg (cloud)' : null, path: null }, ffprobe: { ready: !!ff, version: ff ? 'Bundled (cloud)' : null },
    speech: { ready: true, engine: 'Google voices (online)', version: 'Free online voices; ElevenLabs with your key' }, pexels: pex, freesound: fs, runtime: 'Vercel cloud' };
}
async function speechConfig() {
  const s = await settings.getMany(['OMNIA_SPEECH_PROVIDER', 'OMNIA_SPEECH_LOCALE', 'OMNIA_SPEECH_VOICE']);
  const eleven = await I.keyStatus('elevenlabs');
  return { provider: s.OMNIA_SPEECH_PROVIDER || 'auto', locale: s.OMNIA_SPEECH_LOCALE || 'en-US', voice: s.OMNIA_SPEECH_VOICE || '',
    engines: [{ id: 'gtts', label: 'Google voices', installed: true }, { id: 'elevenlabs', label: 'ElevenLabs', installed: eleven.configured }] };
}
async function backupNow() {
  const tables = ['conversations', 'messages', 'memories', 'memory_changes', 'uploads', 'file_library', 'tasks', 'project_events', 'task_artifacts', 'project_media'];
  const dump = { version: VERSION, created_at: new Date().toISOString(), tables: {} };
  for (const t of tables) dump.tables[t] = await all(`SELECT * FROM ${t}`);
  const filename = `omnia-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, data = Buffer.from(JSON.stringify(dump));
  const saved = await store.put(`backups/${filename}`, data, 'application/json');
  await run('INSERT INTO backups(filename,path,size_bytes) VALUES(?,?,?)', [filename, saved.url, data.length]);
  return { ok: true, filename, size_bytes: data.length };
}

export async function systemRoutes(method, parts, b, url, request) {
  const p = parts.slice(1).join('/');
  if (p === 'health') return json({ ok: true, service: 'OMNIA IQ', version: VERSION, database: await dbKind(), storage: store.kind });
  if (p === 'auth-status') { const { sessionUser } = await import('../auth.js'); const u = await sessionUser(request); return json({ protected: false, launch_control_available: false, auth: { setup_required: await setupRequired(), setup_key_configured: !!process.env.OMNIA_ACCESS_KEY, user: u && { username: u.username, display_name: u.display_name, role: u.role, must_change_password: u.must_change_password } } }); }
  if (p === 'status') return json({ ...(await llm.providerStatus()), model: await llm.modelLabel(), brand: 'OMNIA IQ', version: VERSION });
  if (p === 'diagnostics') return json({ ok: true, checks: { database: { ok: true, kind: await dbKind() }, upload_storage: { ok: true, kind: store.kind } }, version: VERSION });
  if (p === 'architecture') return json({ runtime: 'Vercel serverless', database: await dbKind(), storage: store.kind, version: VERSION });
  if (p === 'launch-health') return json({ ok: true, available: false, note: 'Launch Center is not used in the cloud version: the site is already live on Vercel.' });
  if (p === 'llm/providers') return json(await llm.configStatus());
  let m;
  if ((m = p.match(/^llm\/providers\/([\w-]+)$/)) && method === 'POST') {
    const status = await llm.saveProvider(m[1], b.api_key, b.model, b.extra);
    if (!String(b.api_key || '').trim()) return json({ ok: true, status, connection: { ok: false, configured: false, message: `${status.name} credentials removed.` } });
    const connection = await llm.testProvider(m[1]); return json({ ok: !!connection.ok, status, connection });
  }
  if ((m = p.match(/^llm\/providers\/([\w-]+)\/test$/))) { const r = await llm.testProvider(m[1]); return r.ok ? json(r) : json({ detail: r }, 502); }
  if (p === 'video-readiness') {
    const ff = await ffmpegPath(), ready = (await llm.readyProviders()).length > 0, pex = (await I.keyStatus('pexels')).configured;
    const items = [{ key: 'ai', label: 'AI provider', state: ready ? 'ok' : 'blocked', message: ready ? 'Connected' : 'No AI provider connected', fix: ready ? '' : 'Add a free key in Settings → AI providers.' },
      { key: 'ffmpeg', label: 'Video renderer', state: ff ? 'ok' : 'blocked', message: ff ? 'Bundled FFmpeg ready' : 'FFmpeg missing in this deployment' },
      { key: 'speech', label: 'Narration', state: 'ok', message: 'Free online neural voices' },
      { key: 'footage', label: 'Stock footage', state: pex ? 'ok' : 'warn', message: pex ? 'Pexels connected' : 'No Pexels key: videos use designed title scenes', fix: pex ? '' : 'Add a free Pexels key in Settings.' }];
    return json({ can_render: ready && !!ff, summary: ready && ff ? 'Video production is ready.' : 'Video production needs setup.', items });
  }
  if (p === 'languages') return json({ provider: (await speechConfig()).provider, languages: load('languages.json').map(l => ({ ...l, status: 'ready', engines: ['gtts'], qualification: l.code === 'en' ? 'default' : 'untested' })), note: 'Online voices need an internet connection while rendering. Test your selected language before production.' });
  if (p === 'principles') return json(load('principles.json'));
  if (p === 'principles/voices') return json({ ...load('voices.json'), note: 'Qualified means a recorded listening evaluation passed the release gate. Nothing is promoted automatically.' });
  if (p === 'principles/voices/evaluations') return fail(501, 'Voice evaluations are recorded in the desktop version.');
  if (p === 'learning') {
    if (method === 'POST') await settings.set({ OMNIA_LEARNING: b.enabled ? 'true' : 'false' });
    const learned = await all("SELECT COUNT(*) n FROM memories WHERE kind='principle' AND source LIKE 'learned%'");
    return json({ enabled: (await settings.get('OMNIA_LEARNING', 'true')) === 'true', learned_principles: Number(learned[0].n), expiry_days: 90 });
  }
  if (p === 'media' || p === 'media/human-editor') return json(await mediaStatus());
  if (p === 'media/refresh') return json({ ok: true, status: await mediaStatus() });
  if (p === 'media/install-ffmpeg') return json({ ok: true, message: 'FFmpeg is already bundled with the cloud version.' });
  if (p === 'media/install-speech') return json({ ok: true, message: 'Free online voices are built in. Nothing to install.' });
  for (const name of ['pexels', 'freesound']) {
    if (p === `media/${name}`) return json(method === 'POST' ? await I.saveKey(name, b.api_key) : await I.keyStatus(name));
    if (p === `media/${name}/test`) { const r = name === 'pexels' ? await I.testPexels() : await I.testFreesound(); return r.ok ? json(r) : json({ ...r, detail: r.message }, r.configured ? 502 : 400); }
  }
  if (p === 'search/web') return json(await I.webStatus());
  for (const name of ['tavily', 'brave']) {
    if (p === `search/web/${name}` && method === 'POST') { await I.saveKey(name, b.api_key); return json(await I.webStatus()); }
    if (p === `search/web/${name}/test`) { const r = await I.testWeb(name); return r.ok ? json(r) : json({ ...r, detail: r.message }, r.configured ? 502 : 400); }
  }
  if (p === 'media/elevenlabs') return json(method === 'POST' ? await I.saveEleven(b) : await I.elevenStatus());
  if (p === 'media/elevenlabs/voices') return json(await I.elevenVoices());
  if (p === 'media/free-speech' && method === 'POST') { await settings.set({ OMNIA_SPEECH_PROVIDER: b.provider || 'auto', OMNIA_SPEECH_LOCALE: b.locale || 'en-US', OMNIA_SPEECH_VOICE: b.voice || '' }); return json(await speechConfig()); }
  if (p === 'media/free-speech') return json(await speechConfig());
  if (p.startsWith('media/free-speech/') || p.startsWith('media/test-') || p === 'media/voices' || p === 'media/male-voice') {
    const speech = await import('../speech.js');
    return speech.speechRoutes(p, method, b, url);
  }
  if (p === 'media/images/search') return json({ images: [] });
  if (p === 'backup' && method === 'POST') return json(await backupNow());
  if (p === 'backups') return json({ backups: await all('SELECT filename,size_bytes,created_at FROM backups ORDER BY id DESC LIMIT 50') });
  return null;
}
