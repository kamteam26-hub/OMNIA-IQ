// v88.5 access-key protection: set OMNIA_ACCESS_KEY in Vercel to require a login.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverSecret } from './settings.js';
const KEY = () => process.env.OMNIA_ACCESS_KEY || '';
export const protectedMode = () => !!KEY();
const sign = v => createHmac('sha256', serverSecret()).update(v).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export const PUBLIC = new Set(['system/auth-status', 'system/session', 'system/session/logout', 'system/health']);
export function sessionCookie() {
  const exp = String(Date.now() + 30 * 864e5), v = `${exp}.${sign(exp)}`;
  return `omnia_session=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}`;
}
export const clearCookie = 'omnia_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
function validSession(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)omnia_session=([^;]+)/); if (!m) return false;
  const [exp, sig] = m[1].split('.'); return !!sig && eq(sig, sign(exp)) && Number(exp) > Date.now();
}
export function checkKey(key) { return protectedMode() && !!key && eq(key, KEY()); }
// returns null when allowed, or a reason string
export function denied(request, path) {
  if (!protectedMode() || PUBLIC.has(path)) return null;
  if (validSession(request)) return null;
  const k = request.headers.get('x-omnia-access-key');
  if (!k) return 'missing access key';
  return checkKey(k) ? null : 'invalid access key';
}
