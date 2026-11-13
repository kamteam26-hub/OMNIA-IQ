// OMNIA IQ — Vercel Routing Middleware
// Optional login lock for the whole site (Basic Auth).
// Set OMNIA_USER and OMNIA_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.
// While they are not set, the site is open to anyone with the link.
import { next } from '@vercel/functions';

export const config = { matcher: '/:path*' };

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
  if (ok === false) {
    return new Response('Login required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="OMNIA IQ", charset="UTF-8"' },
    });
  }
  return next(); // ok === true (logged in) or null (no password set yet: site is open)
}
