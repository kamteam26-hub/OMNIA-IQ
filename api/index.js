// OMNIA IQ — cloud backend (runs entirely on Vercel).
// AI:      Vercel AI Gateway (automatic on Vercel) or any OpenAI-compatible API (AI_API_KEY + AI_BASE_URL + AI_MODEL).
// Storage: Vercel Blob, private store (connect a Blob store to the project). Without it, data lives in memory only.
// Video:   MP4 rendering with ffmpeg-static (captioned scenes, no voice-over).
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { writeFile, readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MODEL = process.env.OMNIA_MODEL || 'google/gemini-2.5-flash';
const MAX_UPLOAD = 4 * 1024 * 1024;
const TEXT_CAP = 60000;

/* ---------------------------------------------------------------- helpers */
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, detail) => json({ detail }, status);
const nowIso = () => new Date().toISOString();
const sid = () => randomUUID().replace(/-/g, '').slice(0, 12);
const ts13 = () => String(Date.now()).padStart(13, '0');

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
const store = (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) ? blobStore(process.env.BLOB_STORE_ID, process.env.BLOB_READ_WRITE_TOKEN) : memoryStore();
const readJSON = async b => JSON.parse((await store.read(b.url)).toString('utf8'));
const seg = (pathname, i) => pathname.split('/')[i];

// latest version of each record under a prefix, grouped by directory segment `idx`
async function latestRecords(prefix, idx) {
  const blobs = await store.list(prefix);
  const groups = new Map();
  for (const b of blobs) {
    const id = seg(b.pathname, idx);
    const prev = groups.get(id);
    if (!prev || b.pathname > prev.pathname) groups.set(id, b);
  }
  return { blobs, groups };
}

/* ---------------------------------------------------------------- AI */
function aiConfig(request) {
  const gw = process.env.AI_GATEWAY_API_KEY || request?.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN;
  if (process.env.AI_API_KEY) return { name: 'Cloud AI API', url: (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '') + '/chat/completions', key: process.env.AI_API_KEY, model: process.env.AI_MODEL || 'gemini-2.5-flash' };
  if (gw) return { name: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh/v1/chat/completions', key: gw, model: MODEL };
  return null;
}
async function llm(request, messages, { maxTokens = 4000, model } = {}) {
  if (process.env.OMNIA_MOCK_LLM) { // local testing only
    const last = String(typeof messages.at(-1).content === 'string' ? messages.at(-1).content : messages.at(-1).content[0].text);
    if (last.includes('"scenes"')) return '```json\n' + JSON.stringify({ title: 'AI Agents', summary: 'Test', scenes: [1, 2, 3].map(i => ({ title: `Scene ${i} title`, caption: 'Agents plan, act and verify work so your team saves hours every week.', narration: 'n', visual: 'v' })) }) + '\n```';
    if (last.includes('"files"')) return JSON.stringify({ summary: 'Test site', files: [{ path: 'index.html', content: '<h1>Hi</h1>' }, { path: 'css/styles.css', content: 'h1{color:gold}' }] });
    return `MOCK:${last.slice(0, 60)}`;
  }
  const cfg = aiConfig(request);
  if (!cfg) throw Object.assign(new Error('No AI provider is connected. On Vercel this uses the AI Gateway automatically; otherwise set AI_API_KEY.'), { status: 503 });
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || cfg.model, messages, max_tokens: maxTokens }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`AI provider error (${r.status}): ${d.error?.message || JSON.stringify(d).slice(0, 300)}`), { status: 502 });
  return d.choices?.[0]?.message?.content?.trim() || '';
}
function parseJSON(text) {
  const t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('The AI did not return valid JSON');
}

const PERSONA = `You are OMNIA IQ, an adaptive AI assistant and production studio created by KAM Team. You reason carefully, write clearly, and complete work end to end. When files are attached, use their contents. Be direct and practical.`;

/* ---------------------------------------------------------------- files */
const TEXT_EXT = /\.(txt|md|csv|json|js|mjs|cjs|ts|tsx|jsx|py|html?|css|scss|xml|ya?ml|toml|ini|env|sql|sh|bat|ps1|java|c|cpp|h|cs|go|rs|rb|php|swift|kt|vue|svelte|log)$/i;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|venv|\.venv|__pycache__|\.cache)(\/|$)/;

function unzipEntries(buf) {
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
function extractText(name, mime, buf) {
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
async function loadFiles(ids = []) {
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    const b = (await store.list(`files/${String(id).replace(/[^\w-]/g, '')}/`)).find(x => x.pathname.includes('/meta'));
    if (b) out.push(await readJSON(b));
  }
  return out;
}

/* ---------------------------------------------------------------- memory */
async function allMemories() {
  const { groups } = await latestRecords('mem/', 1);
  const list = await Promise.all([...groups.values()].map(async b => ({ ...(await readJSON(b)), _url: b.url })));
  return list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
function relevant(memories, query, n = 6) {
  const words = new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  return memories.map(m => ({ m, s: (m.content.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(w => words.has(w)).length + (m.importance || 1) * 0.1 }))
    .filter(x => x.s >= 1).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.m);
}
async function addMemory(content, kind = 'knowledge', importance = 3) {
  const id = sid();
  const rec = { id, kind, content: content.slice(0, 4000), importance, created_at: nowIso() };
  await store.put(`mem/${id}/m.json`, JSON.stringify(rec), 'application/json');
  return rec;
}

/* ---------------------------------------------------------------- chat */
async function chatHistory(limit = 40) {
  const blobs = (await store.list('chat/')).sort((a, b) => a.pathname.localeCompare(b.pathname));
  const recent = blobs.slice(-limit);
  return Promise.all(recent.map(readJSON));
}
async function saveMsg(role, content) {
  await store.put(`chat/${ts13()}-${sid()}/m.json`, JSON.stringify({ role, content, created_at: nowIso() }), 'application/json');
}
function userContent(text, files) {
  const parts = [{ type: 'text', text }];
  for (const f of files) {
    if (f.text) parts.push({ type: 'text', text: `\n\n[Attached file: ${f.filename}]\n${f.text}` });
    else if (f.image_data) parts.push({ type: 'image_url', image_url: { url: f.image_data } });
    else parts.push({ type: 'text', text: `\n\n[Attached file: ${f.filename} (${f.mime_type}, ${f.size} bytes) — binary content cannot be read directly.]` });
  }
  return parts.length === 1 ? text : parts;
}
const SPECIALISTS = [
  ['Reasoner', 'Analyse the request rigorously: goals, constraints, risks, and the best approach. Be concise.'],
  ['Engineer', 'Focus on concrete implementation: exact steps, code, configurations, and checks. Be concise.'],
  ['Creator', 'Focus on clarity, communication, creative angles and the end-user experience. Be concise.'],
];
async function chat(request, body) {
  const message = String(body.message || '').trim();
  if (!message) return fail(400, 'Message is empty');
  const [hist, mems, files] = await Promise.all([chatHistory(20), allMemories(), loadFiles(body.file_ids || [])]);
  const memText = relevant(mems, message).map(m => `- (${m.kind}) ${m.content}`).join('\n');
  const system = PERSONA + (memText ? `\n\nLong-term memory that may be relevant:\n${memText}` : '');
  const convo = [{ role: 'system', content: system }, ...hist.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })), { role: 'user', content: userContent(message, files) }];
  let reply, used = [aiConfig(request)?.model || MODEL];
  if (body.harmony) {
    const drafts = await Promise.all(SPECIALISTS.map(([name, role]) =>
      llm(request, [{ role: 'system', content: `${system}\n\nYou are the ${name} specialist. ${role}` }, ...convo.slice(1)], { maxTokens: 1500 }).then(t => `### ${name}\n${t}`).catch(e => `### ${name}\n(unavailable: ${e.message})`)));
    reply = await llm(request, [{ role: 'system', content: `${system}\n\nYou are the conductor. Merge the specialist drafts into one excellent final answer for the user. Do not mention the specialists.` },
      { role: 'user', content: `User request:\n${message}\n\nSpecialist drafts:\n${drafts.join('\n\n')}` }]);
    used = SPECIALISTS.map(s => s[0]).concat('Conductor');
  } else {
    reply = await llm(request, convo);
  }
  await saveMsg('user', message + (files.length ? `\n[Attached: ${files.map(f => f.filename).join(', ')}]` : ''));
  await saveMsg('assistant', reply);
  const m = message.match(/^(?:please\s+)?remember(?:\s+that)?[:\s]+(.{5,})/i);
  if (m) await addMemory(m[1], 'teaching', 4);
  return json({ reply, providers_used: used });
}

/* ---------------------------------------------------------------- projects */
const STUDIOS = [
  { id: 'website', name: 'Website Studio', icon: '◧', description: 'Responsive multi-page websites and landing pages, packaged as ready-to-host HTML/CSS/JS.' },
  { id: 'software', name: 'Software Studio', icon: '⌘', description: 'Working code projects with structure, README and setup instructions.' },
  { id: 'video', name: 'Video Studio', icon: '▶', description: 'Script, storyboard and a rendered MP4 with captioned scenes.' },
  { id: 'automation', name: 'Automation Studio', icon: '⚙', description: 'Workflow blueprints, scripts and step-by-step automation guides.' },
  { id: 'marketing', name: 'Marketing Studio', icon: '✦', description: 'Campaign plans, ad copy, email sequences and social content.' },
  { id: 'document', name: 'Document Studio', icon: '▤', description: 'Reports, proposals, SOPs and guides in Markdown and HTML.' },
];
function detectStudio(text) {
  const t = text.toLowerCase();
  if (/video|reel|mp4|explainer|youtube|tiktok|short/.test(t)) return 'video';
  if (/website|landing page|web page|site\b/.test(t)) return 'website';
  if (/automat|workflow|zapier|make\.com|n8n|webhook/.test(t)) return 'automation';
  if (/marketing|campaign|ads?\b|email sequence|social|seo/.test(t)) return 'marketing';
  if (/app|code|script|software|api|program|tool/.test(t)) return 'software';
  return 'document';
}
const STAGES = ['Plan', 'Produce', 'Package', 'Verify'];
async function allProjects() {
  const { groups } = await latestRecords('proj/', 1);
  const list = await Promise.all([...groups.values()].map(readJSON));
  return list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
async function saveProject(p) {
  p.updated_at = nowIso();
  const old = (await store.list(`proj/${p.id}/`));
  await store.put(`proj/${p.id}/${ts13()}.json`, JSON.stringify(p), 'application/json');
  await store.del(old.map(b => b.url));
  return p;
}
async function getProject(id) {
  const blobs = (await store.list(`proj/${id}/`)).sort((a, b) => a.pathname.localeCompare(b.pathname));
  return blobs.length ? readJSON(blobs[blobs.length - 1]) : null;
}

// minimal ZIP writer (stored, no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path.replace(/^\/+/, '')), data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content));
    const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name); offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function ffmpegPath() {
  try { const m = await import('ffmpeg-static'); const p = m.default || m; if (p) { await access(p); return p; } } catch {}
  for (const p of [join(ROOT, 'node_modules/ffmpeg-static/ffmpeg'), '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) { try { await access(p); return p; } catch {} }
  return null;
}
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26, timeout: 240000 }, (e, so, se) => e ? rej(new Error(String(se).slice(-800) || e.message)) : res(so)));
function wrap(text, width = 38) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' '); const lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; } else line += ' ' + w; }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 6).join('\n');
}
async function renderVideo(title, scenes) {
  const ff = await ffmpegPath(); if (!ff) throw new Error('FFmpeg is not available in this deployment');
  const dir = await mkdtemp(join(tmpdir(), 'omnia-'));
  try {
    const font = join(ROOT, 'assets/DejaVuSans-Bold.ttf');
    const colors = ['0x0b1324', '0x101a33', '0x15122e', '0x0e1f2a', '0x1a1426', '0x0d1a1a'];
    const list = [{ title, caption: 'Produced by OMNIA IQ' }, ...scenes].slice(0, 10);
    const args = ['-y'], filters = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i], dur = i === 0 ? 3 : 5;
      await writeFile(join(dir, `t${i}.txt`), wrap(s.title || '', 30));
      await writeFile(join(dir, `c${i}.txt`), wrap(s.caption || s.narration || '', 44));
      args.push('-f', 'lavfi', '-i', `color=c=${colors[i % colors.length]}:s=1280x720:d=${dur}:r=30`);
      filters.push(`[${i}:v]drawbox=x=0:y=ih-8:w=iw*(t/${dur}):h=8:color=0xd9a632@0.9:t=fill,` +
        `drawtext=fontfile='${font}':textfile='${join(dir, `t${i}.txt`)}':fontcolor=white:fontsize=${i === 0 ? 64 : 52}:line_spacing=10:x=(w-text_w)/2:y=(h-text_h)/2-90,` +
        `drawtext=fontfile='${font}':textfile='${join(dir, `c${i}.txt`)}':fontcolor=0xcfd6e2:fontsize=32:line_spacing=12:x=(w-text_w)/2:y=(h/2)+40,` +
        `fade=t=in:st=0:d=0.4,fade=t=out:st=${dur - 0.4}:d=0.4[v${i}]`);
    }
    const out = join(dir, 'out.mp4');
    args.push('-filter_complex', filters.join(';') + ';' + list.map((_, i) => `[v${i}]`).join('') + `concat=n=${list.length}:v=1:a=0[out]`,
      '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
    await run(ff, args);
    return await readFile(out);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const STUDIO_PROMPTS = {
  website: 'Produce a complete, polished, responsive static website (index.html plus any extra pages, styles.css, script.js). Real copy, no lorem ipsum.',
  software: 'Produce a working software project: source files, a README.md with setup and usage, and any config files needed.',
  automation: 'Produce an automation package: README.md with the workflow blueprint (triggers, steps, error handling), plus any scripts or JSON workflow exports.',
  marketing: 'Produce a marketing package: strategy.md, ad-copy.md, email-sequence.md, social-posts.md, tailored to the brief.',
  document: 'Produce the requested document as a well-structured Markdown file plus a styled standalone HTML version.',
};
async function runProject(request, id, body) {
  const p = await getProject(id); if (!p) return fail(404, 'Project not found');
  const studio = p.project_type && p.project_type !== 'auto' ? p.project_type : detectStudio(`${p.title} ${p.instructions || ''}`);
  const files = await loadFiles(body.file_ids || []);
  const ctx = files.map(f => f.text ? `[Attached: ${f.filename}]\n${f.text.slice(0, 20000)}` : `[Attached binary: ${f.filename}]`).join('\n\n');
  const mems = relevant(await allMemories(), `${p.title} ${p.instructions || ''}`).map(m => `- ${m.content}`).join('\n');
  const ev = (stage, status, detail = '') => { const e = p.events.find(x => x.stage === stage); Object.assign(e, { status, detail }); };
  p.status = 'running'; p.studio = studio; p.events = STAGES.map(stage => ({ stage, status: 'pending', detail: '' }));
  ev('Plan', 'running', `Studio: ${studio}`); await saveProject(p);
  const brief = `Project: ${p.title}\nInstructions: ${p.instructions || '(none)'}\n${mems ? `Relevant memory:\n${mems}\n` : ''}${ctx ? `\nAttached material:\n${ctx}` : ''}`;
  try {
    const artifacts = []; let report;
    const keep = async (filename, content, mime) => {
      const r = await store.put(`art/${p.id}/${sid()}/${filename}`, content, mime);
      artifacts.push({ filename, mime_type: mime, url: r.url });
    };
    if (studio === 'video') {
      ev('Plan', 'done'); ev('Produce', 'running', 'Writing script and storyboard'); await saveProject(p);
      const plan = parseJSON(await llm(request, [{ role: 'system', content: PERSONA }, { role: 'user', content: `${brief}\n\nPlan a short video. Return ONLY JSON: {"title": string, "summary": string, "scenes": [{"title": string (max 6 words), "caption": string (max 22 words), "narration": string, "visual": string}]} with 5-8 scenes.` }]));
      const scenes = (plan.scenes || []).slice(0, 8);
      const script = scenes.map((s, i) => `Scene ${i + 1}: ${s.title}\nVisual: ${s.visual || ''}\nNarration: ${s.narration || s.caption}\n`).join('\n');
      ev('Produce', 'running', 'Rendering MP4'); await saveProject(p);
      let mp4 = null, videoNote = '';
      try { mp4 = await renderVideo(plan.title || p.title, scenes); } catch (e) { videoNote = `Video render failed: ${e.message}`; }
      ev('Produce', mp4 ? 'done' : 'failed', videoNote); ev('Package', 'running');
      if (mp4) await keep('omnia_iq_video.mp4', mp4, 'video/mp4');
      await keep('script.txt', script, 'text/plain');
      await keep('storyboard.json', JSON.stringify(plan, null, 2), 'application/json');
      const pkg = [{ path: 'script.txt', content: script }, { path: 'storyboard.json', content: JSON.stringify(plan, null, 2) }];
      if (mp4) pkg.push({ path: 'omnia_iq_video.mp4', content: mp4 });
      await keep(`${slug(p.title)}.zip`, zip(pkg), 'application/zip');
      report = `${plan.summary || ''}\n\nScenes: ${scenes.length}. ${mp4 ? 'MP4 rendered (captioned scenes, no voice-over in the cloud version).' : videoNote}\n\n${script}`;
    } else {
      ev('Plan', 'done'); ev('Produce', 'running', 'Generating files'); await saveProject(p);
      const out = parseJSON(await llm(request, [{ role: 'system', content: PERSONA }, { role: 'user', content: `${brief}\n\n${STUDIO_PROMPTS[studio] || STUDIO_PROMPTS.document}\nReturn ONLY JSON: {"summary": string, "files": [{"path": string, "content": string}]}. Include every file's full content.` }], { maxTokens: 16000 }));
      const files2 = (out.files || []).filter(f => f && f.path && typeof f.content === 'string').slice(0, 40);
      if (!files2.length) throw new Error('The AI returned no files');
      ev('Produce', 'done', `${files2.length} files`); ev('Package', 'running'); await saveProject(p);
      await keep(`${slug(p.title)}.zip`, zip(files2), 'application/zip');
      for (const f of files2.slice(0, 5)) await keep(f.path.split('/').pop(), f.content, mimeOf(f.path));
      report = `${out.summary || ''}\n\nFiles:\n${files2.map(f => `- ${f.path} (${f.content.length} chars)`).join('\n')}`;
    }
    ev('Package', 'done'); ev('Verify', 'done', `${artifacts.length} artifacts`);
    p.status = 'completed'; p.result = report.trim(); await saveProject(p);
    await addMemory(`Completed project "${p.title}" (${studio}): ${(report || '').slice(0, 300)}`, 'project', 2);
    return json({ status: p.status, artifacts: artifacts.map(a => ({ filename: a.filename, mime_type: a.mime_type })) });
  } catch (e) {
    const cur = p.events.find(x => x.status === 'running'); if (cur) Object.assign(cur, { status: 'failed', detail: e.message });
    p.status = 'failed'; p.result = `Failed: ${e.message}`; await saveProject(p);
    return fail(e.status || 500, e.message);
  }
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
const mimeOf = p => ({ html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', md: 'text/markdown', py: 'text/x-python', svg: 'image/svg+xml' }[p.split('.').pop().toLowerCase()] || 'text/plain');

async function projectArtifacts(id) {
  const blobs = (await store.list(`art/${id}/`)).sort((a, b) => a.pathname.localeCompare(b.pathname));
  return blobs.map(b => {
    const filename = b.pathname.split('/').slice(3).join('/').replace(/-[A-Za-z0-9]{20,}(\.[^.]+)?$|-\d{13,}(\.[^.]+)?$/, '$1$2');
    const ext = filename.split('.').pop().toLowerCase();
    return { id: `${id}.${seg(b.pathname, 2)}`, filename, mime_type: ext === 'zip' ? 'application/zip' : ext === 'mp4' ? 'video/mp4' : mimeOf(filename), size: b.size, _blob: b };
  });
}

/* ---------------------------------------------------------------- router */
async function route(request, method, path) {
  const body = method === 'POST' && (request.headers.get('content-type') || '').includes('application/json') ? await request.json().catch(() => ({})) : {};
  let m;
  // system
  if (path === 'system/health') return json({ ok: true, storage: store.kind, time: nowIso() });
  if (path === 'system/status') {
    const cfg = aiConfig(request);
    const providers = [{ name: cfg?.name || 'Cloud AI', model: cfg?.model || MODEL, role: 'conductor', ready: !!cfg || !!process.env.OMNIA_MOCK_LLM }];
    if (store.kind !== 'blob') providers.push({ name: 'Storage (connect Vercel Blob to keep data)', model: 'temporary memory', role: 'storage', ready: false });
    else providers.push({ name: 'Vercel Blob storage', model: 'persistent', role: 'storage', ready: true });
    return json({ ready: providers[0].ready, multi_api: false, providers });
  }
  if (path === 'system/media' || path === 'system/media/refresh') {
    const ff = await ffmpegPath();
    const status = { ready: !!ff, install_supported: false, ffmpeg: { ready: !!ff, version: ff ? 'Bundled ffmpeg (cloud)' : null, path: null }, ffprobe: { ready: !!ff, version: ff ? 'Not needed in the cloud' : null }, speech: { ready: false, engine: 'None', version: 'Voice-over is not available in the cloud version' } };
    return json(path.endsWith('refresh') ? { status } : status);
  }
  if (path === 'system/media/install-ffmpeg') return fail(400, 'FFmpeg is already bundled with the cloud version.');
  if (path.startsWith('system/media/')) return fail(400, 'Voice-over (Piper) only runs in the local PC version. Cloud videos use captions instead.');
  // chat
  if (path === 'chat/history' && method === 'GET') return json({ messages: (await chatHistory(60)).map(({ role, content }) => ({ role, content })) });
  if (path === 'chat/history' && method === 'DELETE') { await store.del((await store.list('chat/')).map(b => b.url)); return json({ ok: true }); }
  if (path === 'chat' && method === 'POST') return chat(request, body);
  // files
  if (path === 'files/upload' && method === 'POST') {
    const form = await request.formData().catch(() => null);
    const file = form?.get('document');
    if (!file || typeof file === 'string') return fail(400, 'No file received');
    if (file.size > MAX_UPLOAD) return fail(413, `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB. The cloud version accepts files up to 4 MB.`);
    const buf = Buffer.from(await file.arrayBuffer()), id = sid(), mime = file.type || 'application/octet-stream';
    const saved = await store.put(`files/${id}/data`, buf, mime);
    const rec = { file_id: id, local_file_id: id, filename: file.name, mime_type: mime, size: buf.length, url: saved.url, created_at: nowIso(), text: extractText(file.name, mime, buf) };
    if (!rec.text && /^image\/(png|jpe?g|webp|gif)$/.test(mime) && buf.length < 3 * 1048576) rec.image_data = `data:${mime};base64,${buf.toString('base64')}`;
    await store.put(`files/${id}/meta.json`, JSON.stringify(rec), 'application/json');
    return json({ file_id: id, filename: rec.filename, size: rec.size, readable: !!(rec.text || rec.image_data) });
  }
  if (path === 'files/uploads') {
    const blobs = (await store.list('files/')).filter(b => b.pathname.includes('/meta'));
    const recs = await Promise.all(blobs.map(readJSON));
    return json({ uploads: recs.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ local_file_id, filename, created_at, size }) => ({ local_file_id, filename, created_at, size })) });
  }
  // memory
  if (path === 'memory' && method === 'GET') { const mems = await allMemories(); return json({ stats: { c: mems.length, chars: mems.reduce((n, x) => n + x.content.length, 0) }, memories: mems.map(({ _url, ...r }) => r) }); }
  if (path === 'memory' && method === 'POST') { if (!String(body.content || '').trim()) return fail(400, 'Memory is empty'); return json(await addMemory(String(body.content), body.kind || 'knowledge', Number(body.importance) || 3)); }
  if ((m = path.match(/^memory\/([\w-]+)$/)) && method === 'DELETE') { await store.del((await store.list(`mem/${m[1]}/`)).map(b => b.url)); return json({ ok: true }); }
  // projects
  if (path === 'projects/studios') return json({ studios: STUDIOS });
  if (path === 'projects' && method === 'GET') return json({ tasks: await allProjects() });
  if (path === 'projects' && method === 'POST') {
    const title = String(body.title || '').trim(); if (!title) return fail(400, 'Project title is required');
    const p = { id: sid(), title, instructions: String(body.instructions || ''), project_type: body.project_type || 'auto', status: 'queued', events: STAGES.map(stage => ({ stage, status: 'pending', detail: '' })), result: '', created_at: nowIso() };
    return json(await saveProject(p));
  }
  if ((m = path.match(/^projects\/artifacts\/([\w.-]+)\/download$/))) {
    const [pid] = m[1].split('.');
    const a = (await projectArtifacts(pid)).find(x => x.id === m[1]);
    if (!a) return fail(404, 'Artifact not found');
    const data = await store.read(a._blob.url);
    return new Response(data, { headers: { 'content-type': a.mime_type, 'content-disposition': `attachment; filename="${a.filename.replace(/"/g, '')}"`, 'cache-control': 'no-store' } });
  }
  if ((m = path.match(/^projects\/([\w-]+)\/artifacts$/))) return json({ artifacts: (await projectArtifacts(m[1])).map(({ _blob, ...a }) => a) });
  if ((m = path.match(/^projects\/([\w-]+)\/run$/)) && method === 'POST') return runProject(request, m[1], body);
  if ((m = path.match(/^projects\/([\w-]+)$/)) && method === 'DELETE') {
    const urls = [...await store.list(`proj/${m[1]}/`), ...await store.list(`art/${m[1]}/`)].map(b => b.url);
    await store.del(urls); return json({ ok: true });
  }
  return fail(404, `Unknown endpoint: /api/${path}`);
}

async function handle(request) {
  const url = new URL(request.url);
  const path = (url.searchParams.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  try { return await route(request, request.method, path); }
  catch (e) { console.error(e); return fail(e.status || 500, e.message || 'Server error'); }
}
export const GET = handle, POST = handle, DELETE = handle, PUT = handle;
