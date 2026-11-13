// OMNIA IQ — Vercel Routing Middleware
// 1. Locks the whole site behind a username/password (Basic Auth).
// 2. Forwards every /api/* request to the OMNIA IQ backend running on your PC,
//    adding a secret header that only your PC's gatekeeper (Caddy) accepts.
//
// Vercel → Settings → Environment Variables (Production):
//   OMNIA_USER         login name for the website            (e.g. michael)
//   OMNIA_PASSWORD     login password for the website
//   OMNIA_BACKEND_URL  your PC's public tunnel address        (e.g. https://my-pc.tail1234.ts.net)
//   OMNIA_BACKEND_KEY  long random secret, SAME value as in remote\omnia-remote.env on your PC
import { next, rewrite } from '@vercel/functions';

export const config = { matcher: '/:path*' };

function json(status, detail) {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function authorized(request) {
  const user = process.env.OMNIA_USER || '';
  const pass = process.env.OMNIA_PASSWORD || '';
  if (!user || !pass) return null; // not configured
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

export default function middleware(request) {
  const ok = authorized(request);
  if (ok === null) {
    return new Response('OMNIA IQ is locked: set OMNIA_USER and OMNIA_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.', { status: 503 });
  }
  if (!ok) {
    return new Response('Login required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="OMNIA IQ", charset="UTF-8"' },
    });
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return next();

  const base = (process.env.OMNIA_BACKEND_URL || '').replace(/\/+$/, '');
  const key = process.env.OMNIA_BACKEND_KEY || '';
  if (!base || !key) {
    return json(503, 'OMNIA IQ backend is not connected yet: set OMNIA_BACKEND_URL and OMNIA_BACKEND_KEY in Vercel, then redeploy.');
  }

  const headers = new Headers(request.headers);
  headers.delete('authorization');          // never forward the website password to the PC
  headers.set('x-omnia-key', key);          // Caddy on the PC only accepts requests with this
  return rewrite(new URL(url.pathname + url.search, base), { request: { headers } });
}
