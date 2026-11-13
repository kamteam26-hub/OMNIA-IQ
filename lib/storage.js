// File storage: private Vercel Blob store (OIDC on Vercel), or process memory for local tests.
import { createHash } from 'node:crypto';
/* ---------------------------------------------------------------- storage */
// Every record is an immutable object; "updates" write a new version and delete the old one.
function blobStore(storeId, token) {
  // Private store. On Vercel the SDK signs in automatically with OIDC; BLOB_READ_WRITE_TOKEN is optional.
  const ns = 'omnia/' + createHash('sha256').update(storeId || token).digest('hex').slice(0, 20) + '/';
  const auth = token ? { token } : {};
  let sdk;
  const lib = async () => (sdk ||= await import('@vercel/blob'));
  return {
    kind: 'blob',
    async put(path, body, contentType) {
      const { put } = await lib();
      const r = await put(ns + path, body, { access: 'private', addRandomSuffix: true, contentType, ...auth });
      return { url: r.url, downloadUrl: r.downloadUrl, pathname: r.pathname.slice(ns.length) };
    },
    async list(prefix) {
      const { list } = await lib();
      const out = []; let cursor;
      do {
        const r = await list({ prefix: ns + prefix, cursor, limit: 1000, ...auth });
        for (const b of r.blobs) out.push({ url: b.url, downloadUrl: b.downloadUrl, pathname: b.pathname.slice(ns.length), size: b.size, uploadedAt: b.uploadedAt });
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out;
    },
    async read(url) {
      const { get } = await lib();
      const r = await get(url, { access: 'private', ...auth });
      if (!r || !r.stream) throw new Error('Storage read failed');
      return Buffer.from(await new Response(r.stream).arrayBuffer());
    },
    async del(urls) { if (!urls.length) return; const { del } = await lib(); await del(urls, auth); },
  };
}
function memoryStore() {
  const g = (globalThis.__omniaMem ||= new Map());
  let n = 0;
  return {
    kind: 'memory',
    async put(path, body, contentType) {
      const pathname = path.replace(/(\.[a-z0-9]+)?$/i, m => `-${Date.now()}${n++}${m}`);
      const url = 'mem://' + pathname;
      g.set(url, { pathname, body: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType, uploadedAt: new Date() });
      return { url, downloadUrl: url, pathname };
    },
    async list(prefix) { return [...g.entries()].filter(([, v]) => v.pathname.startsWith(prefix)).map(([url, v]) => ({ url, downloadUrl: url, pathname: v.pathname, size: v.body.length, uploadedAt: v.uploadedAt })); },
    async read(url) { const v = g.get(url); if (!v) throw new Error('Not found'); return v.body; },
    async del(urls) { urls.forEach(u => g.delete(u)); },
  };
}
export const store = (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) ? blobStore(process.env.BLOB_STORE_ID, process.env.BLOB_READ_WRITE_TOKEN) : memoryStore();
export const readJSON = async b => JSON.parse((await store.read(b.url)).toString('utf8'));
