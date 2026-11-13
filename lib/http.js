export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export const fail = (status, detail) => json({ detail }, status);
export class HttpError extends Error { constructor(status, detail) { super(typeof detail === 'string' ? detail : JSON.stringify(detail)); this.status = status; this.detail = detail; } }
export const nowIso = () => new Date().toISOString();
export async function body(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return {};
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return {};
  return request.json().catch(() => ({}));
}
export const mask = v => !v ? '' : v.length <= 8 ? '•'.repeat(v.length) : `${v.slice(0, 4)}${'•'.repeat(Math.min(16, v.length - 8))}${v.slice(-4)}`;
