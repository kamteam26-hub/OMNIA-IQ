// Media runtime: bundled FFmpeg (ffmpeg-static) on Vercel, system FFmpeg for local tests.
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let cached;
export async function ffmpegPath() {
  if (cached !== undefined) return cached;
  try { const m = await import('ffmpeg-static'); const p = m.default || m; if (p) { await access(p); return (cached = p); } } catch {}
  for (const p of [join(ROOT, 'node_modules/ffmpeg-static/ffmpeg'), '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) { try { await access(p); return (cached = p); } catch {} }
  return (cached = null);
}
export const run = (cmd, args, timeout = 240000) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26, timeout }, (e, so, se) => e ? rej(new Error(String(se).slice(-800) || e.message)) : res(String(se || so))));
export const FONT = join(ROOT, 'assets/DejaVuSans-Bold.ttf');
