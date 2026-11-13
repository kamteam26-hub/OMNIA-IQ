// OMNIA IQ accounts & security: users with roles (admin / user), password login (scrypt),
// revocable sessions, login lockout, per-user rate limits and daily quotas, and an admin audit log.
// First run: the owner creates the admin account with the setup key (OMNIA_ACCESS_KEY in Vercel).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { all, one, run } from './db.js';
import { serverSecret } from './settings.js';
import * as settings from './settings.js';

const scrypt = promisify(_scrypt);
const store = new AsyncLocalStorage();
export const withUser = (user, fn) => store.run({ user }, fn);
export const currentUser = () => store.getStore()?.user || null;
export const ownerId = () => currentUser()?.id ?? 0;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login TEXT)`,
  `CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at REAL NOT NULL, last_seen REAL NOT NULL, expires_at REAL NOT NULL, ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, ip TEXT NOT NULL, ok INTEGER NOT NULL, time REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, time REAL NOT NULL, user_id INTEGER, username TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', status INTEGER, ip TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time)`,
  `CREATE TABLE IF NOT EXISTS usage_counters (user_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day, kind))`,
];
// Per-user data ownership for the user workspace.
const OWNED = ['conversations', 'uploads', 'memories', 'tasks'];
let ready;
export const ensureAuth = () => (ready ||= (async () => {
  for (const s of SCHEMA) await run(s);
  for (const t of OWNED) {
    const cols = new Set((await all(`PRAGMA table_info(${t})`)).map(c => c.name));
    if (!cols.has('owner_id')) await run(`ALTER TABLE ${t} ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0`);
  }
})().catch(e => { ready = null; throw e; }));

// ---------------- security policy (admin-editable)
export const DEFAULT_POLICY = { session_hours: 12, idle_minutes: 120, lockout_attempts: 5, lockout_minutes: 15, min_password_length: 10,
  rate_per_minute: 120, ai_per_day: 200, videos_per_day: 10, storage_mb_per_user: 500, audit_days: 90 };
export async function policy() {
  let p = {}; try { p = JSON.parse((await settings.get('OMNIA_SECURITY_POLICY')) || '{}'); } catch {}
  return { ...DEFAULT_POLICY, ...p };
}
export async function savePolicy(input) {
  const cur = await policy(), out = { ...cur };
  const lim = { session_hours: [1, 720], idle_minutes: [5, 1440], lockout_attempts: [3, 20], lockout_minutes: [1, 1440], min_password_length: [8, 64], rate_per_minute: [10, 2000], ai_per_day: [0, 100000], videos_per_day: [0, 1000], storage_mb_per_user: [10, 100000], audit_days: [7, 3650] };
  for (const [k, [lo, hi]] of Object.entries(lim)) if (input[k] != null) { const v = Math.round(Number(input[k])); if (!(v >= lo && v <= hi)) throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}`), { status: 422 }); out[k] = v; }
  await settings.set({ OMNIA_SECURITY_POLICY: JSON.stringify(out) }); return out;
}

// ---------------- passwords
export async function hashPassword(pw) { const salt = randomBytes(16); const h = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }); return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`; }
async function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$'); if (!s || !h) return false;
  const got = await scrypt(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 }), exp = Buffer.from(h, 'base64');
  return got.length === exp.length && timingSafeEqual(got, exp);
}
export async function checkPasswordPolicy(pw, username = '') {
  const p = await policy(); pw = String(pw || '');
  if (pw.length < p.min_password_length) return `Password must be at least ${p.min_password_length} characters.`;
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username.';
  return null;
}
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// ---------------- sessions
const sign = v => createHmac('sha256', serverSecret()).update('session:' + v).digest('base64url');
export const clientIp = r => (r.headers.get('x-forwarded-for') || '').split(',')[0].trim() || r.headers.get('x-real-ip') || '';
export async function createSession(user, request) {
  const p = await policy(), id = randomBytes(24).toString('base64url'), t = Date.now() / 1000;
  await run('INSERT INTO user_sessions(id,user_id,created_at,last_seen,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?)', [id, user.id, t, t, t + p.session_hours * 3600, clientIp(request), (request.headers.get('user-agent') || '').slice(0, 200)]);
  await run('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?', [user.id]);
  return `omnia_session=${id}.${sign(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${p.session_hours * 3600}`;
}
export const clearCookie = 'omnia_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
const sessionId = request => { const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)omnia_session=([^;]+)/); if (!m) return null; const [id, sig] = m[1].split('.'); return sig && eq(sig, sign(id)) ? id : null; };
export async function sessionUser(request) {
  const id = sessionId(request); if (!id) return null;
  const s = await one('SELECT s.*, u.username, u.display_name, u.role, u.active, u.must_change_password FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?', [id]);
  const t = Date.now() / 1000, p = await policy();
  if (!s || s.revoked || !s.active || s.expires_at < t || t - s.last_seen > p.idle_minutes * 60) return null;
  if (t - s.last_seen > 60) await run('UPDATE user_sessions SET last_seen=? WHERE id=?', [t, id]);
  return { id: s.user_id, username: s.username, display_name: s.display_name || s.username, role: s.role, session_id: id, must_change_password: !!s.must_change_password };
}
export async function revokeSession(request) { const id = sessionId(request); if (id) await run('UPDATE user_sessions SET revoked=1 WHERE id=?', [id]); }

// ---------------- login with lockout
export async function login(username, password, request) {
  const p = await policy(), ip = clientIp(request), since = Date.now() / 1000 - p.lockout_minutes * 60; username = String(username || '').trim();
  const fails = (await one('SELECT COUNT(*) n FROM login_attempts WHERE (username=? COLLATE NOCASE OR ip=?) AND ok=0 AND time>?', [username, ip, since])).n;
  if (fails >= p.lockout_attempts) { await audit(null, 'login_locked', { detail: username, ip }); throw Object.assign(new Error(`Too many failed sign-ins. Try again in ${p.lockout_minutes} minutes.`), { status: 429 }); }
  const u = await one('SELECT * FROM users WHERE username=? COLLATE NOCASE', [username]);
  const ok = !!u && !!u.active && await verifyPassword(String(password || ''), u.password_hash);
  if (!u) await verifyPassword('x', 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); // equalize timing
  await run('INSERT INTO login_attempts(username,ip,ok,time) VALUES(?,?,?,?)', [username.slice(0, 100), ip, ok ? 1 : 0, Date.now() / 1000]);
  await audit(ok ? u : null, ok ? 'login' : 'login_failed', { detail: username, ip });
  if (!ok) throw Object.assign(new Error(u && !u.active ? 'This account is disabled. Ask the administrator.' : 'Wrong username or password.'), { status: 401 });
  return u;
}
export async function setupAdmin(setupKey, username, password, displayName) {
  if ((await one('SELECT COUNT(*) n FROM users')).n) throw Object.assign(new Error('Setup is already complete. Sign in instead.'), { status: 409 });
  const key = process.env.OMNIA_ACCESS_KEY || '';
  if (!key) throw Object.assign(new Error('Setup is locked. Add OMNIA_ACCESS_KEY (your private setup key) in Vercel → Settings → Environment Variables, redeploy, then come back.'), { status: 503 });
  if (!eq(setupKey || '', key)) throw Object.assign(new Error('Setup key is not correct.'), { status: 401 });
  username = String(username || '').trim(); if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw Object.assign(new Error('Username: 3-40 letters, numbers, dot, dash or underscore.'), { status: 422 });
  const bad = await checkPasswordPolicy(password, username); if (bad) throw Object.assign(new Error(bad), { status: 422 });
  const id = (await run('INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,?,?)', [username, String(displayName || username).slice(0, 80), await hashPassword(password), 'admin'])).lastId;
  // Data created before accounts existed belongs to the first admin.
  for (const t of OWNED) await run(`UPDATE ${t} SET owner_id=? WHERE owner_id=0`, [id]);
  const u = await one('SELECT * FROM users WHERE id=?', [id]); await audit(u, 'setup_admin', {}); return u;
}

// ---------------- access rules
export const PUBLIC = new Set(['system/auth-status', 'system/health', 'auth/login', 'auth/setup', 'auth/logout', 'automation/tick']);
const isPublic = path => PUBLIC.has(path) || path.startsWith('publishing/public-media/') || path === 'publishing/oauth/google/callback';
// Admin-only areas (the admin dashboard). Users keep chat, files, video studio, projects and memory.
const USER_SYSTEM_READS = new Set(['system/status', 'system/media', 'system/media/refresh', 'system/languages', 'system/principles', 'system/principles/voices', 'system/video-readiness', 'system/media/free-speech', 'system/media/free-speech/voices', 'system/learning', 'system/media/free-speech/test']);
export function adminOnly(method, path) {
  const top = path.split('/')[0];
  if (['admin', 'agent-studio', 'automation', 'publishing', 'launch'].includes(top)) return true;
  if (top === 'system') { if (USER_SYSTEM_READS.has(path) && (method === 'GET' || path.endsWith('/test') || path.endsWith('/refresh'))) return false; return true; }
  if (top === 'assistant' && path.startsWith('assistant/ollama')) return true;
  return false;
}
export const protectedMode = () => true;
export const setupRequired = async () => (await one('SELECT COUNT(*) n FROM users')).n === 0;

// ---------------- rate limits & quotas
const buckets = new Map();
export async function rateLimit(user) {
  const p = await policy(), key = user?.id ?? 'anon', t = Math.floor(Date.now() / 60000), b = buckets.get(key);
  if (!b || b.t !== t) { buckets.set(key, { t, n: 1 }); return null; }
  return ++b.n > p.rate_per_minute ? 'Too many requests. Slow down for a minute.' : null;
}
const today = () => new Date().toISOString().slice(0, 10);
export async function useQuota(kind) {
  const u = currentUser(); if (!u || u.role === 'admin') return;
  const p = await policy(), limit = kind === 'video' ? p.videos_per_day : p.ai_per_day;
  const row = await one('SELECT n FROM usage_counters WHERE user_id=? AND day=? AND kind=?', [u.id, today(), kind]);
  if ((row?.n || 0) >= limit) throw Object.assign(new Error(`Daily limit reached (${limit} ${kind === 'video' ? 'video builds' : 'AI requests'}). Ask the administrator to raise it.`), { status: 429 });
  await run('INSERT INTO usage_counters(user_id,day,kind,n) VALUES(?,?,?,1) ON CONFLICT(user_id,day,kind) DO UPDATE SET n=n+1', [u.id, today(), kind]);
}
export async function checkStorage(extraBytes) {
  const u = currentUser(); if (!u || u.role === 'admin') return;
  const p = await policy(), used = (await one('SELECT COALESCE(SUM(size_bytes),0) b FROM uploads WHERE owner_id=?', [u.id])).b;
  if (used + extraBytes > p.storage_mb_per_user * 1048576) throw Object.assign(new Error(`Storage limit reached (${p.storage_mb_per_user} MB). Delete files or ask the administrator.`), { status: 413 });
}

// ---------------- audit
export async function audit(user, action, { method = '', path = '', status = null, ip = '', detail = '' } = {}) {
  try { await run('INSERT INTO audit_log(time,user_id,username,action,method,path,status,ip,detail) VALUES(?,?,?,?,?,?,?,?,?)', [Date.now() / 1000, user?.id ?? null, user?.username || '', action, method, path.slice(0, 200), status, ip, String(detail).slice(0, 500)]); } catch {}
}
export { isPublic };
