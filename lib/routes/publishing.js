// Publishing Center (port of v88.5 publishing/: adapters, service, store, oauth, vault) for Vercel.
// Official APIs only: YouTube (Google OAuth), Facebook Pages & Instagram (Meta Graph), TikTok (inbox).
// Every upload needs explicit approval. The queue advances on API activity, the open page and Vercel Cron.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { json, fail, HttpError } from '../http.js';
import { all, one, run } from '../db.js';
import { store } from '../storage.js';
import * as settings from '../settings.js';
import { protectedMode } from '../auth.js';

const PLATFORMS = ['instagram', 'facebook', 'youtube', 'tiktok'];
const META_VERSION = 'v23.0';
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
class ProviderError extends HttpError { constructor(m) { super(502, m); } }
const bad = m => { throw new HttpError(400, m); };
const now = () => Date.now() / 1000;
const slug = v => String(v || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
const tokenEnvFor = (client, platform, id = '') => 'OMNIA_SOCIAL_TOKEN_' + ((id || `${client}_${platform}`).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'ACCOUNT');
const graph = () => `https://graph.facebook.com/${META_VERSION}`;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pub_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pub_accounts (id TEXT PRIMARY KEY, config TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pub_posts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, media TEXT NOT NULL, checksum TEXT NOT NULL, created REAL NOT NULL, approved REAL, due REAL NOT NULL, reviewer TEXT, media_name TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS pub_deliveries (post_id TEXT NOT NULL, account TEXT NOT NULL, state TEXT NOT NULL, remote_id TEXT, error TEXT, updated REAL NOT NULL, PRIMARY KEY(post_id, account))`,
  `CREATE TABLE IF NOT EXISTS pub_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, time REAL NOT NULL, revision INTEGER NOT NULL)`,
];
let ready; const ensure = () => (ready ||= (async () => { for (const s of SCHEMA) await run(s); })().catch(e => { ready = null; throw e; }));

// ---------------- vault (encrypted settings)
const vget = async k => settings.get(k);
const vput = async (k, v) => settings.set({ [k]: typeof v === 'string' ? v : JSON.stringify(v) }, { secret: [k] });
const vdel = async k => settings.set({ [k]: '' });
const vjson = async k => { try { return JSON.parse((await vget(k)) || '{}'); } catch { return {}; } };
async function signingKey() { let k = await vget('OMNIA_SOCIAL_MEDIA_SIGNING_KEY'); if (k.length < 32) { k = randomBytes(36).toString('base64url'); await vput('OMNIA_SOCIAL_MEDIA_SIGNING_KEY', k); } return k; }

// ---------------- events into Automation
async function notify(type, postId, extra = {}) {
  try {
    const p = await one('SELECT payload,state FROM pub_posts WHERE id=?', [postId]); const pl = p ? JSON.parse(p.payload) : {};
    const a = await import('./automation.js');
    await a.emit('publishing', type, { post_id: postId, status: type.split('.').pop(), title: pl.title || 'Untitled post', client_id: pl.client_id || 'default', state: p?.state, ...extra });
  } catch {}
}
const record = (post, action, actor = 'system') => run('INSERT INTO pub_audit(post_id,action,actor,time,revision) VALUES(?,?,?,?,?)', [post.id, action, actor, now(), post.revision]);

// ---------------- accounts
async function accounts() {
  await ensure(); const out = {};
  for (const r of await all('SELECT config FROM pub_accounts')) { const a = JSON.parse(r.config); out[a.id] = Object.fromEntries(['id', 'platform', 'label', 'target_id', 'token_env', 'client_id'].filter(k => k in a).map(k => [k, a[k]])); }
  return out;
}
async function hasGoogleRefresh(id) { return !!(await vjson('GOOGLE_REFRESH:' + id)).refresh_token; }
async function hasToken(a) { if (a.platform === 'youtube' && a.id && await hasGoogleRefresh(a.id)) return true; return !!(await vget(a.token_env || '')); }
async function token(a) {
  if (a.platform === 'youtube' && a.id && await hasGoogleRefresh(a.id)) return googleAccessToken(a.id);
  const v = await vget(a.token_env || ''); if (!v) bad('Account token is missing; reconnect the account or paste a new token in Publishing → Accounts'); return v;
}
export async function publicAccounts() {
  await ensure(); const out = [];
  for (const r of await all('SELECT config FROM pub_accounts')) {
    const a = JSON.parse(r.config);
    out.push({ id: a.id, platform: a.platform, label: a.label || a.id, client_id: a.client_id || 'default', token_env: a.token_env || '', target_id: a.target_id || '', configured: await hasToken(a), connection: a.auth === 'google_oauth' ? 'oauth' : 'saved', mode: a.platform === 'tiktok' ? 'inbox — finish in TikTok' : 'API upload' });
  }
  return out;
}
async function saveAccount(config) {
  config = { ...config }; const secret = String(config.token || '').trim(); delete config.token;
  if (!PLATFORMS.includes(config.platform)) bad('Select YouTube, Facebook, Instagram or TikTok');
  config.client_id = String(config.client_id || 'default').trim() || 'default';
  config.target_id = String(config.target_id || '').trim();
  if (!config.id) config.id = slug(`${config.client_id}-${config.platform}-${config.target_id.slice(-6)}`) || slug(`${config.client_id}-${config.platform}`);
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(config.id)) bad('Account ID may use letters, numbers, dashes and underscores (max 60)');
  if (['facebook', 'instagram'].includes(config.platform) && !/^\d+$/.test(config.target_id)) bad('Meta destination ID must be numeric — use “Connect Facebook & Instagram” to find it automatically');
  if (config.platform === 'youtube' && !/^UC[a-zA-Z0-9_-]{22}$/.test(config.target_id)) bad('Enter the YouTube channel ID beginning with UC — or use “Connect YouTube” to fill it automatically');
  config.token_env = String(config.token_env || '').trim() || tokenEnvFor(config.client_id, config.platform, config.id);
  if (!/^OMNIA_SOCIAL_TOKEN_[A-Z0-9_]{1,80}$/.test(config.token_env)) bad('Token variable must look like OMNIA_SOCIAL_TOKEN_NAME');
  config.label = String(config.label || '').trim().slice(0, 120) || `${config.client_id} ${config.platform}`;
  config.auth ||= 'token';
  if (secret) { if (secret.length > 4096 || /\s/.test(secret)) bad('That does not look like an access token (no spaces allowed)'); await vput(config.token_env, secret); }
  await run('INSERT OR REPLACE INTO pub_accounts VALUES(?,?)', [config.id, JSON.stringify(config)]);
  await record({ id: 'account:' + config.id, revision: 1 }, 'account saved', 'operator');
  return { saved: true, id: config.id, token_stored: !!secret, configured: await hasToken(config) };
}
async function deleteAccount(id) {
  const row = await one('SELECT config FROM pub_accounts WHERE id=?', [id]); if (!row) bad('Account not found');
  const busy = (await one("SELECT COUNT(*) n FROM pub_deliveries WHERE account=? AND state IN ('sending','transferring','publishing','container','processing')", [id])).n;
  if (busy) bad('This account has an upload in progress; wait for it to finish first');
  const config = JSON.parse(row.config);
  await run('DELETE FROM pub_accounts WHERE id=?', [id]); await record({ id: 'account:' + id, revision: 1 }, 'account removed', 'operator');
  if (!Object.values(await accounts()).some(a => a.token_env === config.token_env)) await vdel(config.token_env);
  await vdel('GOOGLE_REFRESH:' + id);
  return { removed: true };
}

// ---------------- HTTP helper for providers
async function preq(method, url, { headers = {}, form, body, jsonBody, query } = {}) {
  if (query) url += '?' + new URLSearchParams(query);
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (jsonBody) { init.body = JSON.stringify(jsonBody); init.headers['content-type'] = 'application/json'; }
  else if (form) init.body = form; else if (body) init.body = body;
  const r = await fetch(url, init);
  if (!r.ok) throw new ProviderError(`Provider HTTP ${r.status}; inspect permissions, quota, and token expiry`);
  const text = await r.text(); if (!text) return {};
  const j = JSON.parse(text); if (j.error && j.error.code && j.error.code !== 'ok') throw new ProviderError('Provider rejected the operation; verify configuration and quota');
  return j;
}

// ---------------- Meta discovery
async function metaDiscover(clientId, tok) {
  tok = String(tok || '').trim(); if (!tok || /\s/.test(tok)) bad('Paste the access token from Meta Graph API Explorer or your Meta app');
  const auth = { authorization: 'Bearer ' + tok }; let pages = [];
  try { pages = (await preq('GET', graph() + '/me/accounts', { headers: auth, query: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100 } })).data || []; } catch {}
  if (!pages.length) { const me = await preq('GET', graph() + '/me', { headers: auth, query: { fields: 'id,name,instagram_business_account{id,username}' } }); if (!me.id) throw new ProviderError('Meta did not return any Pages for this token; grant pages_show_list and pages_manage_posts'); pages = [{ ...me, access_token: tok }]; }
  const found = [];
  for (const p of pages) {
    found.push({ platform: 'facebook', target_id: String(p.id), name: p.name || 'Facebook Page', token: p.access_token || tok });
    const ig = p.instagram_business_account || {}; if (ig.id) found.push({ platform: 'instagram', target_id: String(ig.id), name: '@' + (ig.username || 'instagram'), page: p.name || '', token: p.access_token || tok });
  }
  const handle = randomBytes(18).toString('base64url');
  await vput('META_DISCOVERY:' + handle, { time: now(), client_id: clientId, items: found });
  return { discovery: handle, destinations: found.map(({ token: _, ...x }, index) => ({ ...x, index })) };
}
async function metaConnect(handle, indexes, clientId) {
  const item = await vjson('META_DISCOVERY:' + handle); if (!item.items || item.time < now() - 900) bad('That connection expired; paste the token again');
  const client = String(clientId || item.client_id || 'default').trim(), saved = [];
  for (const i of indexes) {
    const d = item.items[Number(i)]; if (!d) bad('Unknown destination selection');
    const aid = slug(`${client}-${d.platform}-${d.target_id.slice(-6)}`);
    saved.push((await saveAccount({ id: aid, client_id: client, label: d.name, platform: d.platform, target_id: d.target_id, token_env: tokenEnvFor(client, d.platform, aid), token: d.token, auth: 'meta_page_token' })).id);
  }
  await vdel('META_DISCOVERY:' + handle); return { saved };
}

// ---------------- Google OAuth (YouTube)
async function googleClient() { return [await vget('OMNIA_GOOGLE_CLIENT_ID'), await vget('OMNIA_GOOGLE_CLIENT_SECRET')]; }
const googleConfigured = async () => { const [c, s] = await googleClient(); return !!(c && s); };
async function tokenRequest(data) {
  const [cid, secret] = await googleClient();
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...data, client_id: cid, client_secret: secret }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (j.error === 'invalid_grant') bad('Google access was revoked or expired; click Connect YouTube again'); bad(`Google sign-in failed (HTTP ${r.status}); check the client ID, secret and redirect URI`); }
  return j;
}
const tokenCache = new Map();
async function googleAccessToken(id) {
  const c = tokenCache.get(id); if (c && c[1] > now()) return c[0];
  const refresh = (await vjson('GOOGLE_REFRESH:' + id)).refresh_token; if (!refresh) bad('YouTube is not connected; click Connect YouTube');
  const t = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' }); tokenCache.set(id, [t.access_token, now() + (t.expires_in || 3600) - 120]); return t.access_token;
}
async function oauthStart(clientId, redirect) {
  const [cid] = await googleClient(); if (!cid) bad('Save your Google OAuth client ID and secret first');
  const state = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await vput('GOOGLE_PENDING:' + state, { time: now(), client_id: String(clientId || 'default').trim() || 'default', redirect_uri: redirect, verifier });
  const q = new URLSearchParams({ client_id: cid, redirect_uri: redirect, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q, redirect_uri: redirect };
}
async function oauthCallback(code, state) {
  const pending = await vjson('GOOGLE_PENDING:' + (state || '')); await vdel('GOOGLE_PENDING:' + (state || ''));
  if (!pending.time || pending.time < now() - 900) bad('This sign-in link expired; click Connect YouTube again');
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: pending.redirect_uri, code_verifier: pending.verifier });
  if (!t.refresh_token || !t.access_token) bad('Google did not return offline access; remove OMNIA from your Google account permissions and connect again');
  const channels = (await preq('GET', 'https://www.googleapis.com/youtube/v3/channels', { headers: { authorization: 'Bearer ' + t.access_token }, query: { part: 'id,snippet', mine: 'true' } })).items || [];
  if (!channels.length) bad('This Google account has no YouTube channel; create one in YouTube first');
  const saved = [];
  for (const ch of channels) {
    const aid = slug(`${pending.client_id}-youtube-${ch.id.slice(-6)}`);
    await saveAccount({ id: aid, client_id: pending.client_id, label: ch.snippet?.title || 'YouTube channel', platform: 'youtube', target_id: ch.id, token_env: tokenEnvFor(pending.client_id, 'youtube', aid), auth: 'google_oauth' });
    await vput('GOOGLE_REFRESH:' + aid, { refresh_token: t.refresh_token, channel: ch.id, connected: now() });
    tokenCache.set(aid, [t.access_token, now() + (t.expires_in || 3600) - 120]); saved.push({ id: aid, name: ch.snippet?.title || '' });
  }
  return { saved };
}
async function verifyAccount(a) {
  const auth = { authorization: 'Bearer ' + await token(a) };
  if (a.platform === 'youtube') { const b = await preq('GET', 'https://www.googleapis.com/youtube/v3/channels', { headers: auth, query: { part: 'id,snippet', mine: 'true' } }); const it = (b.items || []).find(x => x.id === a.target_id); if (!it) bad('Authorized YouTube channel does not match the selected client channel'); return { id: it.id, name: it.snippet.title }; }
  if (a.platform === 'facebook') { const b = await preq('GET', graph() + '/me', { headers: auth, query: { fields: 'id,name' } }); if (String(b.id) !== a.target_id) bad('Page token owner does not match the configured Facebook Page'); return { id: b.id, name: b.name }; }
  if (a.platform === 'instagram') { const b = await preq('GET', `${graph()}/${a.target_id}`, { headers: auth, query: { fields: 'id,username' } }); if (String(b.id) !== a.target_id) bad('Instagram identity mismatch'); return { id: b.id, name: b.username }; }
  bad('Account verification is unavailable for this platform');
}

// ---------------- media & posts
let requestOrigin = '';
async function mediaBase() { return ((await vget('OMNIA_SOCIAL_MEDIA_BASE_URL')) || requestOrigin || '').replace(/\/+$/, ''); }
const ext = name => (String(name).match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
async function signature(post) { return createHmac('sha256', await signingKey()).update(post.id + post.checksum).digest('hex'); }
async function mediaUrl(post) { return `${await mediaBase()}/api/publishing/public-media/${post.id}?signature=${await signature(post)}`; }
async function getPost(id) {
  const r = await one('SELECT * FROM pub_posts WHERE id=?', [id]); if (!r) bad('Post not found');
  return { ...r, payload: JSON.parse(r.payload), deliveries: await all('SELECT * FROM pub_deliveries WHERE post_id=?', [id]), audit: await all('SELECT * FROM pub_audit WHERE post_id=? ORDER BY id', [id]) };
}
async function listPosts(limit = 200) {
  const rows = await all('SELECT * FROM pub_posts ORDER BY created DESC LIMIT ?', [limit]); if (!rows.length) return [];
  const ids = rows.map(r => r.id), marks = ids.map(() => '?').join(','), d = {}, au = {};
  for (const x of await all(`SELECT * FROM pub_deliveries WHERE post_id IN (${marks})`, ids)) (d[x.post_id] ||= []).push(x);
  for (const x of await all(`SELECT * FROM pub_audit WHERE post_id IN (${marks}) ORDER BY id`, ids)) (au[x.post_id] ||= []).push(x);
  return rows.map(r => ({ ...r, payload: JSON.parse(r.payload), deliveries: d[r.id] || [], audit: au[r.id] || [] }));
}
const view = p => { const { media, ...rest } = p; return rest; };
async function result(postId, account, state, remoteId = null, error = null) {
  await run('UPDATE pub_deliveries SET state=?, remote_id=COALESCE(?,remote_id), error=?, updated=? WHERE post_id=? AND account=?', [state, remoteId, error, now(), postId, account]);
  const states = (await all('SELECT state FROM pub_deliveries WHERE post_id=?', [postId])).map(r => r.state);
  const agg = states.every(s => ['published', 'uploaded', 'awaiting_creator'].includes(s)) ? 'completed' : states.some(s => ['failed', 'uncertain'].includes(s)) ? 'needs_review' : 'processing';
  await run('UPDATE pub_posts SET state=? WHERE id=?', [agg, postId]);
  const p = await one('SELECT id,revision FROM pub_posts WHERE id=?', [postId]); await record(p, `${account}:${state}`);
  if (['published', 'uploaded', 'awaiting_creator', 'failed', 'uncertain'].includes(state)) await notify('delivery.' + (['failed', 'uncertain'].includes(state) ? 'needs_attention' : state), postId, { account, error: error || '', remote_id: remoteId || '' });
}
const automationOn = async () => (await one("SELECT value FROM pub_settings WHERE key='automation'"))?.value === 'on';

async function sourceMedia(b) {
  if ((b.artifact_id == null) === (b.upload_id == null)) bad('Select exactly one finished artifact or uploaded media file');
  if (b.artifact_id != null) { const a = await one('SELECT filename,path,mime_type FROM task_artifacts WHERE id=?', [Number(b.artifact_id)]); if (!a) throw new HttpError(404, 'Media not found'); return { name: a.filename, url: a.path }; }
  const u = await one('SELECT filename,local_file_id FROM uploads WHERE local_file_id=?', [b.upload_id]); if (!u) throw new HttpError(404, 'Media not found'); return { name: u.filename, url: u.local_file_id };
}
async function createPost(payload, src) {
  const configured = await accounts();
  if (!payload.accounts?.length || new Set(payload.accounts).size !== payload.accounts.length) bad('Select one or more distinct destinations');
  for (const a of payload.accounts) if (!configured[a]) bad('Unknown destination account');
  const client = payload.client_id || 'default';
  if (payload.accounts.some(i => (configured[i].client_id || 'default') !== client)) bad('All destinations must belong to the selected client');
  if (!['manual', 'schedule', 'approval'].includes(payload.trigger || 'schedule')) bad('Invalid publishing trigger');
  const e = ext(src.name); if (!['.jpg', '.jpeg', '.png', '.mp4', '.mov', '.webm'].includes(e)) bad('Choose a supported existing image or video');
  const data = await store.read(src.url); if (!data.length) bad('Media must be nonempty');
  const id = randomBytes(16).toString('hex'), saved = await store.put(`publishing/media/${id}${e}`, data, e === '.mp4' ? 'video/mp4' : e === '.png' ? 'image/png' : e === '.mov' ? 'video/quicktime' : e === '.webm' ? 'video/webm' : 'image/jpeg');
  const checksum = createHash('sha256').update(data).digest('hex');
  await run('INSERT INTO pub_posts(id,revision,state,payload,media,checksum,created,approved,due,reviewer,media_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id, 1, 'draft', JSON.stringify(payload), saved.url, checksum, now(), null, payload.due, null, `${id}${e}`]);
  for (const a of payload.accounts) await run('INSERT INTO pub_deliveries VALUES(?,?,?,?,?,?)', [id, a, 'pending', null, null, now()]);
  await record({ id, revision: 1 }, 'created', 'operator'); await notify('post.created', id);
  return getPost(id);
}
async function validateFor(a, p, mediaName) {
  await token(a); const e = ext(mediaName);
  if (['youtube', 'tiktok'].includes(a.platform) && e !== '.mp4') bad('YouTube and TikTok require MP4 video in this release');
  if (['instagram', 'facebook'].includes(a.platform) && !/^\d+$/.test(a.target_id || '')) bad('Configure the Instagram professional account ID or Facebook Page ID');
  if (a.platform === 'instagram') { if (!['.jpg', '.jpeg', '.mp4'].includes(e)) bad('Instagram publishing accepts JPEG photos or MP4 Reels in this release'); if (!(await mediaBase()).startsWith('https://')) bad('Instagram downloads media from your public address; set it under Publishing → Setup'); }
  if (a.platform === 'youtube' && !String(p.title || '').trim()) bad('YouTube requires a title');
  if (a.platform === 'youtube' && p.title.length > 100) bad('YouTube title must be at most 100 characters');
  if (String(p.caption || '').length > { instagram: 2200, youtube: 5000, facebook: 60000, tiktok: 60000 }[a.platform]) bad('Caption exceeds this platform’s supported limit');
}
async function decision(postId, revision, action) {
  const p = await one('SELECT * FROM pub_posts WHERE id=?', [postId]); if (!p || p.revision !== revision) bad('Stale review; refresh before continuing');
  if (action === 'approve') {
    if (p.state !== 'draft') bad('Only drafts can be approved');
    const payload = JSON.parse(p.payload), configured = await accounts();
    if (createHash('sha256').update(await store.read(p.media)).digest('hex') !== p.checksum) bad('Media changed; create a new draft');
    for (const a of payload.accounts) {
      if (JSON.stringify(configured[a]) !== JSON.stringify(payload.destination_snapshot[a])) bad('Destination configuration changed; create a new draft');
      await validateFor(configured[a], payload, p.media_name);
    }
    const r = await run("UPDATE pub_posts SET state='approved',approved=?,due=?,reviewer='operator' WHERE id=? AND revision=? AND state='draft'", [now(), payload.trigger === 'approval' ? now() : p.due, postId, revision]);
    if (!r.changes) bad('Stale review; refresh before continuing');
  } else if (['reject', 'cancel'].includes(action)) {
    if (!['draft', 'approved'].includes(p.state)) bad('Upload has started; cancellation cannot undo an external action');
    await run('UPDATE pub_posts SET state=? WHERE id=?', [action === 'reject' ? 'rejected' : 'cancelled', postId]);
    await run("UPDATE pub_deliveries SET state='cancelled' WHERE post_id=? AND state='pending'", [postId]);
  } else bad('Unknown decision');
  await record(p, action, 'operator'); await notify('post.' + { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[action], postId);
  return getPost(postId);
}
async function release(postId, revision, requireDue = false) {
  const p = await one('SELECT * FROM pub_posts WHERE id=?', [postId]);
  if (!p || p.revision !== revision || p.state !== 'approved') bad(requireDue ? 'Approve the current draft before running it' : 'Approve the current draft before releasing it');
  if (requireDue && p.due > now()) bad('Scheduled time has not arrived; edit and approve the new time first');
  const payload = JSON.parse(p.payload);
  if (!payload.manual_released) { payload.manual_released = true; await run('UPDATE pub_posts SET payload=? WHERE id=?', [JSON.stringify(payload), postId]); await record(p, requireDue ? 'manual trigger' : 'released for ' + (p.due <= now() ? 'upload now' : 'scheduled time'), 'operator'); }
  await tick(postId);
  return getPost(postId);
}

// ---------------- provider transports
async function submit(a, p, post) {
  const auth = { authorization: 'Bearer ' + await token(a) }, e = ext(post.media_name), data = await store.read(post.media);
  if (a.platform === 'instagram') {
    const fields = new URLSearchParams({ caption: p.caption || '' }); const url = await mediaUrl(post);
    if (e === '.mp4') { fields.set('media_type', 'REELS'); fields.set('video_url', url); } else fields.set('image_url', url);
    const b = await preq('POST', `${graph()}/${a.target_id}/media`, { headers: auth, body: fields }); await result(post.id, a.id, 'container', b.id); return ['container', b.id];
  }
  if (a.platform === 'facebook') {
    const video = ['.mp4', '.mov', '.webm'].includes(e), base = video ? graph().replace('graph.facebook.com', 'graph-video.facebook.com') : graph();
    const fd = new FormData(); fd.append(video ? 'description' : 'message', p.caption || ''); fd.append('source', new Blob([data]), post.media_name);
    const b = await preq('POST', `${base}/${a.target_id}/${video ? 'videos' : 'photos'}`, { headers: auth, form: fd }); return [video ? 'uploaded' : 'published', String(b.post_id || b.id)];
  }
  if (a.platform === 'youtube') {
    if (a.target_id) await verifyAccount(a);
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', redirect: 'manual', headers: { ...auth, 'content-type': 'application/json', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(data.length) }, body: JSON.stringify({ snippet: { title: p.title, description: p.caption || '' }, status: { privacyStatus: p.privacy || 'private', selfDeclaredMadeForKids: !!p.made_for_kids } }) });
    if (!init.ok) throw new ProviderError(`YouTube initialization HTTP ${init.status}`);
    const loc = init.headers.get('location'); if (!/^https:\/\/([a-z0-9-]+\.)*googleapis\.com\//.test(loc || '')) throw new ProviderError('Provider returned an unsafe upload location');
    const b = await preq('PUT', loc, { headers: { 'content-type': 'video/mp4' }, body: data }); return ['uploaded', b.id];
  }
  if (a.platform === 'tiktok') {
    const size = data.length, chunk = Math.min(size, 10 * 1024 * 1024), count = Math.max(1, Math.floor(size / chunk));
    const b = (await preq('POST', 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', { headers: auth, jsonBody: { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count } } })).data;
    await result(post.id, a.id, 'transferring', b.publish_id);
    if (!/^https:\/\/([a-z0-9-]+\.)*tiktokapis\.com\//.test(b.upload_url || '')) throw new ProviderError('Provider returned an unsafe upload location');
    for (let i = 0, start = 0; i < count; i++) { const len = i < count - 1 ? chunk : size - start; await preq('PUT', b.upload_url, { headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${start + len - 1}/${size}` }, body: data.subarray(start, start + len) }); start += len; }
    return ['processing', b.publish_id];
  }
  bad('Unsupported platform');
}
async function poll(a, d) {
  const auth = { authorization: 'Bearer ' + await token(a) };
  if (a.platform === 'instagram') { const b = await preq('GET', `${graph()}/${d.remote_id}`, { headers: auth, query: { fields: 'status_code' } }); return [b.status_code === 'FINISHED' ? 'ready' : ['ERROR', 'EXPIRED'].includes(b.status_code) ? 'failed' : 'container', d.remote_id]; }
  const s = (await preq('POST', 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', { headers: auth, jsonBody: { publish_id: d.remote_id } })).data?.status;
  return [s === 'PUBLISH_COMPLETE' ? 'published' : s === 'SEND_TO_USER_INBOX' ? 'awaiting_creator' : s === 'FAILED' ? 'failed' : 'processing', d.remote_id];
}

// ---------------- queue worker
let lastTick = 0;
export async function tick(manualPost = null) {
  await ensure();
  if (!manualPost && Date.now() - lastTick < 15000) return; lastTick = Date.now();
  await run("UPDATE pub_deliveries SET state='uncertain',error='Worker interrupted; reconcile the destination before sending again' WHERE state IN ('sending','transferring','publishing') AND updated<?", [now() - 1800]);
  const rows = await all(`SELECT d.*,p.revision FROM pub_deliveries d JOIN pub_posts p ON p.id=d.post_id WHERE p.approved IS NOT NULL AND p.state NOT IN ('draft','cancelled','rejected') AND p.due<=? AND d.state IN ('pending','container','processing')
    AND (d.state != 'pending' OR p.id=? OR json_extract(p.payload,'$.manual_released')=1 OR (COALESCE(json_extract(p.payload,'$.trigger'),'schedule') != 'manual' AND EXISTS(SELECT 1 FROM pub_settings WHERE key='automation' AND value='on')))
    ORDER BY CASE WHEN p.id=? THEN 0 ELSE 1 END,p.created LIMIT 10`, [now(), manualPost, manualPost]);
  for (const d of rows) {
    const post = await getPost(d.post_id), a = (await accounts())[d.account];
    if (!a || JSON.stringify(a) !== JSON.stringify(post.payload.destination_snapshot[d.account])) { await result(post.id, d.account, 'failed', null, 'Destination configuration changed; create and approve a new draft'); continue; }
    const manual = manualPost === post.id || !!post.payload.manual_released;
    if (d.state === 'pending' && !manual && ((post.payload.trigger || 'schedule') === 'manual' || !(await automationOn()))) continue;
    if (d.state !== 'pending') {
      try {
        const [state, remote] = await poll(a, d);
        if (state === 'ready') {
          const ch = await run("UPDATE pub_deliveries SET state='publishing',updated=? WHERE post_id=? AND account=? AND state='container'", [now(), post.id, d.account]); if (!ch.changes) continue;
          let st = 'published', rid = remote;
          try { rid = (await preq('POST', `${graph()}/${a.target_id}/media_publish`, { headers: { authorization: 'Bearer ' + await token(a) }, body: new URLSearchParams({ creation_id: remote }) })).id; } catch { st = 'uncertain'; }
          await result(post.id, d.account, st, rid, st === 'uncertain' ? 'Publish outcome unknown; reconcile before resending' : null);
        } else await result(post.id, d.account, state, remote, state === 'failed' ? 'Provider processing failed' : null);
      } catch { await run('UPDATE pub_deliveries SET error=? WHERE post_id=? AND account=?', ['Status unavailable; automatic status check will retry', post.id, d.account]); }
      continue;
    }
    const ch = await run("UPDATE pub_deliveries SET state='sending',updated=? WHERE post_id=? AND account=? AND state='pending' AND EXISTS(SELECT 1 FROM pub_posts WHERE id=? AND state IN ('approved','processing','needs_review') AND revision=?)", [now(), post.id, d.account, post.id, post.revision]);
    if (!ch.changes) continue;
    await run("UPDATE pub_posts SET state='processing' WHERE id=?", [post.id]);
    try {
      if (createHash('sha256').update(await store.read(post.media)).digest('hex') !== post.checksum) bad('Approved media integrity check failed');
      await validateFor(a, post.payload, post.media_name);
    } catch (e) { await result(post.id, d.account, 'failed', null, e instanceof HttpError ? e.message : 'Preflight failed'); continue; }
    try { const [state, remote] = await submit(a, post.payload, post); await result(post.id, d.account, state, remote); }
    catch { await result(post.id, d.account, 'uncertain', null, 'Upload outcome uncertain; verify destination and remote ID before creating another approved draft'); }
  }
  await run("UPDATE pub_posts SET state='needs_review' WHERE id IN (SELECT post_id FROM pub_deliveries WHERE state='uncertain')");
}

// Used by the Automation "publish_draft" step.
export async function draftFromAutomation(s, payload, vars, render) {
  if (!payload.artifact_id) bad('This event has no finished media; use the trigger “Video or image finished rendering”');
  const art = await one('SELECT filename,path FROM task_artifacts WHERE id=?', [Number(payload.artifact_id)]); if (!art) bad('Finished media no longer exists');
  const configured = await accounts(); let acc = (s.accounts || []).filter(a => configured[a]); if (!acc.length) bad('None of the chosen destinations is connected any more');
  const client = configured[acc[0]].client_id || 'default'; acc = acc.filter(a => (configured[a].client_id || 'default') === client);
  const post = await createPost({ client_id: client, trigger: 'manual', artifact_id: Number(payload.artifact_id), upload_id: null, accounts: acc, title: render(s.title || '{{title}}').trim().slice(0, 100), caption: render(s.caption || '').slice(0, 5000), privacy: s.privacy || 'private', made_for_kids: false, due: now(), destination_snapshot: Object.fromEntries(acc.map(a => [a, configured[a]])) }, { name: art.filename, url: art.path });
  vars.post_id = post.id; return `Draft ${post.id.slice(0, 8)} ready for your approval in Publishing`;
}

async function readiness(listed) {
  listed ||= await publicAccounts();
  const base = await mediaBase(), baseOk = base.startsWith('https://') && !/localhost|\.local$/.test(base);
  const signingOk = (await vget('OMNIA_SOCIAL_MEDIA_SIGNING_KEY')).length >= 32, google = await googleConfigured();
  const req = (label, ok, fix, action = '') => ({ label, ok: ok == null ? null : !!ok, fix: ok ? '' : fix, action: ok ? '' : action });
  const forP = p => { const rows = listed.filter(a => a.platform === p); return [rows, rows.filter(a => a.configured).length]; };
  const [yt, ytc] = forP('youtube'), [fb, fbc] = forP('facebook'), [ig, igc] = forP('instagram'), [tt, ttc] = forP('tiktok');
  const specs = [
    ['youtube', 'YouTube', 'MP4 video · title ≤ 100 · description ≤ 5,000', yt, ytc, [req('Google OAuth app saved (client ID + secret)', google || ytc, 'One time: paste your Google OAuth client ID and secret under Connect YouTube.', 'google_app'), req('YouTube channel connected', ytc, 'Click “Connect YouTube” and sign in with the channel owner.', 'connect_youtube'), req('Google app verified for public uploads', null, 'Unverified Google projects can only upload Private videos — fine for testing.')]],
    ['facebook', 'Facebook Page', 'Photos or video · caption ≤ 60,000', fb, fbc, [req('Facebook Page connected', fbc, 'Click “Connect Facebook & Instagram” and paste a token from Meta.', 'connect_meta')]],
    ['instagram', 'Instagram professional', 'JPEG or MP4 Reel · caption ≤ 2,200', ig, igc, [req('Instagram account connected', igc, 'Link Instagram to your Facebook Page, then Connect Facebook & Instagram.', 'connect_meta'), req('Public HTTPS address for media', baseOk, 'Set the public address under Setup (your Vercel address is used automatically).', 'media_base'), req('Media signing key', signingOk, 'Click “Create signing key” (one click, stored on this server).', 'signing_key')]],
  ];
  const platforms = specs.map(([id, name, limits, rows, configured, reqs]) => ({ id, name, limits, accounts: rows.length, configured, state: !reqs.some(r => r.ok === false) ? 'ready' : rows.length ? 'setup' : 'not_connected', requirements: reqs }));
  if (tt.length) platforms.push({ id: 'tiktok', name: 'TikTok (inbox)', limits: 'MP4 · finish the post in TikTok', accounts: tt.length, configured: ttc, state: ttc ? 'ready' : 'setup', requirements: [req('Token saved', ttc, 'Paste the TikTok token under Accounts.')] });
  return { platforms, config_error: '', automation: await automationOn(), access_key: protectedMode(), media_base_url: baseOk ? base : '', media_base_source: (await vget('OMNIA_SOCIAL_MEDIA_BASE_URL')) ? 'setting' : 'launch', launch_domain: requestOrigin, google_app: google, meta_api_version: META_VERSION, ready_platforms: platforms.filter(p => p.state === 'ready').length, note: 'Configuration checks only. Use Verify to confirm identity; a first private test upload confirms permissions.' };
}
async function mediaList() {
  const out = (await all("SELECT a.id, a.filename, a.mime_type, t.title FROM task_artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.mime_type LIKE 'video/%' OR a.mime_type LIKE 'image/%' ORDER BY t.id DESC, a.id")).map(a => ({ artifact_id: a.id, label: `${a.title} / ${a.filename}`, preview: `/api/projects/artifacts/${a.id}/preview` }));
  for (const u of await all("SELECT u.filename,u.local_file_id FROM uploads u LEFT JOIN file_library m ON m.upload_id=u.id WHERE m.trashed_at IS NULL AND u.media_type IN ('video','image') ORDER BY u.id DESC")) out.push({ upload_id: u.local_file_id, label: u.filename });
  return out;
}
function page(title, text, ok) {
  const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Response(`<!doctype html><meta charset="utf-8"><title>OMNIA · ${e(title)}</title><body style="font-family:system-ui;background:#0b1020;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:520px;padding:28px;border:1px solid #1f2937;border-radius:16px;background:#111827"><h2 style="color:${ok ? '#22c55e' : '#ef4444'};margin-top:0">${e(title)}</h2><p>${e(text)}</p><p><a style="color:#a78bfa" href="/">Return to OMNIA</a> — or close this tab; the Publishing Center refreshes automatically.</p></div><script>try{window.opener&&window.opener.postMessage({omnia:'youtube-connected',ok:${ok}},location.origin)}catch(e){}</script></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function publishingRoutes(method, parts, b, url, request) {
  await ensure();
  requestOrigin = url.origin.startsWith('https://') ? url.origin : requestOrigin;
  const [, a, id, sub] = parts, redirect = `${url.origin}/api/publishing/oauth/google/callback`;
  if (a === 'public-media' && id) {
    const p = await one('SELECT * FROM pub_posts WHERE id=?', [id]); if (!p) return fail(404, 'Post not found');
    if (['draft', 'rejected', 'cancelled'].includes(p.state) || !p.approved || now() > p.due + 7 * 86400) return fail(403, 'Media link unavailable');
    const sig = Buffer.from(url.searchParams.get('signature') || ''), exp = Buffer.from(await signature(p));
    if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return fail(403, 'Invalid media signature');
    return new Response(await store.read(p.media), { headers: { 'content-type': ext(p.media_name) === '.mp4' ? 'video/mp4' : 'image/jpeg', 'cache-control': 'no-store' } });
  }
  if (a === 'oauth' && id === 'google' && sub === 'callback') {
    if (url.searchParams.get('error')) return page('YouTube not connected', `Google sign-in was cancelled or denied (${url.searchParams.get('error').slice(0, 80)}).`, false);
    try { const r = await oauthCallback(url.searchParams.get('code'), url.searchParams.get('state')); return page('YouTube connected', `Connected: ${r.saved.map(x => x.name).join(', ')}. You can now publish to this channel from OMNIA.`, true); }
    catch (e) { return page('YouTube not connected', e.message || 'Unexpected error.', false); }
  }
  if (!protectedMode()) return fail(403, 'Publishing requires an access key: add OMNIA_ACCESS_KEY in Vercel → Settings → Environment Variables, then redeploy.');
  if (a !== 'upload') tick().catch(() => {});
  if (a === 'accounts' && !id && method === 'GET') return json({ accounts: await publicAccounts() });
  if (a === 'accounts' && !id && method === 'PUT') return json(await saveAccount(b));
  if (a === 'accounts' && id && !sub && method === 'DELETE') return json(await deleteAccount(id));
  if (a === 'accounts' && sub === 'verify') { const acc = (await accounts())[id]; if (!acc) return fail(404, 'Account not found'); return json(await verifyAccount(acc)); }
  if (a === 'readiness') return json(await readiness());
  if (a === 'media') return json({ media: await mediaList() });
  if (a === 'planner') {
    const client = url.searchParams.get('client_id'), start = url.searchParams.get('start'), end = url.searchParams.get('end'); const cond = [], args = [];
    if (client) { cond.push("json_extract(p.payload,'$.client_id')=?"); args.push(client); }
    if (start) { cond.push('p.due>=?'); args.push(Number(start)); } if (end) { cond.push('p.due<?'); args.push(Number(end)); }
    const posts = await all('SELECT p.id,p.state,p.due,p.created,p.approved,p.payload FROM pub_posts p' + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') + ' ORDER BY p.due,p.id LIMIT 2000', args);
    const counts = { draft: 0, approved: 0, processing: 0, completed: 0, needs_review: 0, cancelled: 0, rejected: 0 }, results = { published: 0, accepted_not_verified: 0, awaiting_creator: 0, pending: 0, failed_or_uncertain: 0 }, events = [];
    for (const p of posts) {
      const pl = JSON.parse(p.payload); counts[p.state] = (counts[p.state] || 0) + 1; const ds = await all('SELECT account,state FROM pub_deliveries WHERE post_id=?', [p.id]);
      for (const d of ds) { if (d.state === 'published') results.published++; else if (d.state === 'uploaded') results.accepted_not_verified++; else if (d.state === 'awaiting_creator') results.awaiting_creator++; else if (['failed', 'uncertain'].includes(d.state)) results.failed_or_uncertain++; else results.pending++; }
      events.push({ id: p.id, client_id: pl.client_id || 'default', title: pl.title || 'Untitled media', due: p.due, trigger: pl.trigger || 'schedule', state: p.state, destinations: ds });
    }
    return json({ counts, delivery_results: results, events, truncated: posts.length === 2000, timezone: 'UTC', notice: 'Uploaded means provider acceptance, not public publication. TikTok inbox delivery requires creator action.' });
  }
  if (a === 'overview') {
    const data = { automation: await automationOn(), posts: (await listPosts()).map(view) };
    if (url.searchParams.get('include') === 'posts') return json(data);
    const listed = await publicAccounts();
    return json({ ...data, accounts: listed, media: await mediaList(), readiness: await readiness(listed), google: { configured: await googleConfigured(), redirect_uri: redirect } });
  }
  if (a === 'automation') {
    if (method === 'PUT') { await run("INSERT OR REPLACE INTO pub_settings VALUES('automation',?)", [b.enabled ? 'on' : 'off']); await record({ id: 'settings', revision: 1 }, 'automation:' + (b.enabled ? 'on' : 'off'), 'operator'); }
    return json({ enabled: await automationOn() });
  }
  if (a === 'connect' && id === 'meta' && sub === 'discover') return json(await metaDiscover(String(b.client_id || 'default').trim(), b.token));
  if (a === 'connect' && id === 'meta' && sub === 'save') return json(await metaConnect(b.discovery, b.indexes || [], b.client_id));
  if (a === 'connect' && id === 'youtube' && sub === 'start') return json(await oauthStart(b.client_id, redirect));
  if (a === 'google' && id === 'app') {
    if (method === 'PUT') { const cid = String(b.client_id || '').trim(), sec = String(b.client_secret || '').trim(); if (!cid.endsWith('.apps.googleusercontent.com')) bad('The Google client ID ends with .apps.googleusercontent.com'); if (sec.length < 10 || /\s/.test(sec)) bad('Paste the client secret shown next to the client ID'); await vput('OMNIA_GOOGLE_CLIENT_ID', cid); await vput('OMNIA_GOOGLE_CLIENT_SECRET', sec); return json({ saved: true }); }
    return json({ configured: await googleConfigured(), redirect_uri: redirect });
  }
  if (a === 'settings' && !id && method === 'PUT') {
    const u = String(b.media_base_url || '').trim().replace(/\/+$/, '');
    if (u) { let x; try { x = new URL(u); } catch { bad('Use your public address like https://omnia.example.com'); } if (x.protocol !== 'https:' || x.username || !['', '/'].includes(x.pathname)) bad('Use your public address like https://omnia.example.com'); await vput('OMNIA_SOCIAL_MEDIA_BASE_URL', u); } else await vdel('OMNIA_SOCIAL_MEDIA_BASE_URL');
    return json(await readiness());
  }
  if (a === 'settings' && id === 'signing-key') { await signingKey(); return json(await readiness()); }
  if (a === 'upload' && method === 'POST') {
    const form = await request.formData().catch(() => null), file = form?.get('document');
    if (!file || typeof file === 'string' || !['.jpg', '.jpeg', '.png', '.mp4', '.mov', '.webm'].includes(ext(file.name))) return fail(415, 'Select a supported image or video');
    const { saveUpload } = await import('./files.js'); const s = await saveUpload(file, { mediaOnly: true });
    return json({ upload_id: s.file_id, label: s.filename, filename: s.filename, size_bytes: s.size_bytes, media_type: s.media_type });
  }
  if (a === 'posts' && !id && method === 'GET') return json({ posts: (await listPosts()).map(view) });
  if (a === 'posts' && !id && method === 'POST') {
    const trigger = b.trigger || 'manual'; if (!['manual', 'schedule', 'approval'].includes(trigger)) bad('Invalid publishing trigger');
    if (trigger === 'schedule' && b.due == null) bad('Scheduled trigger requires an explicit upload time');
    if (!Array.isArray(b.accounts) || !b.accounts.length || b.accounts.length > 20) bad('Select one or more destinations');
    const src = await sourceMedia(b), configured = await accounts(); if (b.accounts.some(i => !configured[i])) bad('Unknown destination');
    const payload = { client_id: b.client_id || 'default', trigger, artifact_id: b.artifact_id ?? null, upload_id: b.upload_id ?? null, accounts: b.accounts, title: String(b.title || '').slice(0, 100), caption: String(b.caption || '').slice(0, 60000), privacy: ['private', 'unlisted', 'public'].includes(b.privacy) ? b.privacy : 'private', made_for_kids: !!b.made_for_kids, due: Number(b.due ?? now()), destination_snapshot: Object.fromEntries(b.accounts.map(i => [i, configured[i]])) };
    if ((b.approve_now || b.release) && !b.consent) bad('Tick the confirmation box to approve while creating the post');
    let post = await createPost(payload, src);
    if (b.approve_now || b.release) { try { post = await decision(post.id, post.revision, 'approve'); } catch (e) { bad(`Draft saved, but not approved: ${e.message}`); } }
    if (b.release) post = await release(post.id, post.revision);
    return json(view(post));
  }
  if (a === 'posts' && id) {
    if (!sub && method === 'PUT') {
      const p = await one('SELECT * FROM pub_posts WHERE id=?', [id]); if (!p || p.revision !== Number(b.revision) || !['draft', 'approved'].includes(p.state)) bad('Post changed or upload started; refresh the queue');
      const payload = { ...JSON.parse(p.payload), trigger: b.trigger || 'manual', title: String(b.title || '').slice(0, 100), caption: String(b.caption || '').slice(0, 60000), due: Number(b.due), privacy: b.privacy, made_for_kids: !!b.made_for_kids }; delete payload.manual_released;
      await run("UPDATE pub_posts SET payload=?,due=?,revision=revision+1,state='draft',approved=NULL,reviewer=NULL WHERE id=?", [JSON.stringify(payload), payload.due, id]);
      await record({ id, revision: p.revision + 1 }, 'edited — approval invalidated', 'operator'); return json(view(await getPost(id)));
    }
    if (sub === 'preview') { const p = await getPost(id); return new Response(await store.read(p.media), { headers: { 'content-type': ext(p.media_name) === '.mp4' ? 'video/mp4' : 'image/jpeg', 'cache-control': 'no-store' } }); }
    if (sub === 'retry') {
      const p = await one('SELECT * FROM pub_posts WHERE id=?', [id]); if (!p?.approved) bad('Only approved posts can be retried');
      const ch = await run("UPDATE pub_deliveries SET state='pending',error=NULL,updated=? WHERE post_id=? AND state='failed'", [now(), id]); if (!ch.changes) bad('No failed destinations to retry (uncertain uploads must be resolved first)');
      const pl = JSON.parse(p.payload); pl.manual_released = true; await run("UPDATE pub_posts SET state='approved',payload=? WHERE id=?", [JSON.stringify(pl), id]);
      await record(p, `retry ${ch.changes} failed destination(s)`, 'operator'); await tick(id); return json(view(await getPost(id)));
    }
    if (sub === 'resolve') {
      if (!['published', 'not_posted'].includes(b.outcome)) bad('Choose whether the post appeared on the platform');
      const d = await one("SELECT * FROM pub_deliveries WHERE post_id=? AND account=? AND state='uncertain'", [id, b.account]); if (!d) bad('That destination is not awaiting reconciliation');
      if (b.outcome === 'not_posted') await run("UPDATE pub_deliveries SET state='pending',error=NULL,updated=? WHERE post_id=? AND account=?", [now(), id, b.account]);
      else await result(id, b.account, 'published', b.remote_id || d.remote_id, null);
      const states = (await all('SELECT state FROM pub_deliveries WHERE post_id=?', [id])).map(r => r.state);
      if (states.some(s => s === 'pending')) await run("UPDATE pub_posts SET state='approved' WHERE id=?", [id]);
      return json(view(await getPost(id)));
    }
    if (sub === 'run') { if (!b.consent) bad('Explicit manual upload confirmation required'); return json(view(await release(id, Number(b.revision), true))); }
    if (sub === 'release') { if (!b.consent) bad('Explicit release confirmation required'); return json(view(await release(id, Number(b.revision)))); }
    if (['approve', 'reject', 'cancel'].includes(sub)) { if (sub === 'approve' && !b.consent) bad('Explicit approval of media, destinations, metadata, and schedule is required'); return json(view(await decision(id, Number(b.revision), sub))); }
  }
  return null;
}
