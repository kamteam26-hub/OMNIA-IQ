// Key/value settings kept in the database (replaces v88.5's .env writes).
// Secret values are encrypted with AES-256-GCM using a key derived from server-only environment values.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { all, run } from './db.js';

const SECRET_SOURCE = process.env.OMNIA_SECRET || process.env.TURSO_AUTH_TOKEN || process.env.BLOB_STORE_ID || 'omnia-local-dev';
const KEY = createHash('sha256').update('omnia-settings:' + SECRET_SOURCE).digest();
export const serverSecret = () => KEY;

function enc(text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function dec(v) {
  if (!v.startsWith('enc:')) return v;
  try {
    const b = Buffer.from(v.slice(4), 'base64'), d = createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

let cache = null, cacheAt = 0;
async function load() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await all('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map(r => [r.key, dec(r.value)])); cacheAt = Date.now();
  return cache;
}
export async function get(key, fallback = '') {
  if (process.env[key]) return process.env[key];
  const v = (await load())[key];
  return v === undefined || v === null || v === '' ? fallback : v;
}
export async function getMany(keys) { const out = {}; for (const k of keys) out[k] = await get(k); return out; }
export async function set(updates, { secret = [] } = {}) {
  for (const [k, v] of Object.entries(updates)) {
    if (v === '' || v === null || v === undefined) await run('DELETE FROM settings WHERE key=?', [k]);
    else await run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP', [k, secret.includes(k) ? enc(String(v)) : String(v)]);
  }
  cache = null;
}
