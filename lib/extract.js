// Text extraction for uploads: plain text/code files and ZIP archives (manifest + source files).
import { inflateRawSync } from 'node:zlib';
const TEXT_CAP = 60000;
/* ---------------------------------------------------------------- files */
const TEXT_EXT = /\.(txt|md|csv|json|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|ya?ml|toml|ini|env|sql|sh|bat|ps1|java|c|cpp|h|cs|go|rs|rb|php|swift|kt|vue|svelte|log)$/i;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|venv|\.venv|__pycache__|\.cache)(\/|$)/;

export function unzipEntries(buf) {
  const out = []; let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count && p < buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    out.push({ name, size: usize, read: () => {
      const l = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.slice(l, l + csize);
      return method === 0 ? data : inflateRawSync(data);
    } });
  }
  return out;
}
export function extractText(name, mime, buf) {
  if (/\.zip$/i.test(name) || mime === 'application/zip') {
    const entries = unzipEntries(buf).filter(e => !e.name.endsWith('/') && !SKIP.test(e.name));
    let text = `ZIP archive "${name}" — ${entries.length} files.\nManifest:\n` + entries.slice(0, 300).map(e => `- ${e.name} (${e.size} bytes)`).join('\n') + '\n\nSelected source files:\n';
    for (const e of entries.filter(e => TEXT_EXT.test(e.name) && e.size < 200000)) {
      if (text.length > TEXT_CAP) break;
      try { text += `\n----- ${e.name} -----\n${e.read().toString('utf8').slice(0, 12000)}\n`; } catch {}
    }
    return text.slice(0, TEXT_CAP);
  }
  if (TEXT_EXT.test(name) || /^text\//.test(mime) || /json|xml|javascript/.test(mime)) return buf.toString('utf8').slice(0, TEXT_CAP);
  return '';
}
