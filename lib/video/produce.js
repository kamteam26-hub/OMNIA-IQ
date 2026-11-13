// Cloud video production: narration per scene, visuals (your media → Pexels footage → designed cards),
// matched background music (Freesound CC0 → generated ambient bed), captions, and an MP4 render.
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath, run, FONT } from '../media.js';
import { store } from '../storage.js';
import * as settings from '../settings.js';
import * as llm from '../llm.js';
import { narrate } from './tts.js';
import { contract, normalize } from './contract.js';

const SIZES = { '9:16': [720, 1280], '16:9': [1280, 720], '1:1': [720, 720] };
const PALETTE = ['0x0b1324', '0x14102b', '0x0e1f2a', '0x1a1426', '0x0d1a1a', '0x111827'];

function splitScenes(script, duration) {
  const sentences = normalize(script).replace(/\n+/g, ' ').match(/[^.!?。！？]+[.!?。！？]*["”’)]*\s*/g)?.map(s => s.trim()).filter(Boolean) || [normalize(script)];
  const n = Math.max(3, Math.min(12, Math.round(duration / 6), sentences.length));
  const per = Math.ceil(sentences.length / n), scenes = [];
  for (let i = 0; i < sentences.length; i += per) scenes.push(sentences.slice(i, i + per).join(' '));
  return scenes;
}
function wrap(text, width) {
  const words = String(text).split(/\s+/), lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > width) { if (line) lines.push(line.trim()); line = w; } else line += ' ' + w; }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
async function duration(ff, file) {
  try { await run(ff, ['-hide_banner', '-i', file], 30000); } catch (e) {
    const m = String(e.message).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
  return 0;
}
async function download(url, file, headers = {}) {
  const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`download ${r.status}`);
  await writeFile(file, Buffer.from(await r.arrayBuffer())); return file;
}

async function planVisuals(script, scenes, c) {
  try {
    const r = await llm.chat([{ role: 'system', content: 'You choose stock-footage search terms. Reply with JSON only.' },
      { role: 'user', content: `Video narration scenes:\n${scenes.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nReturn {"queries": [one short English stock-footage search query per scene, 2-4 concrete visual words each], "mood": "one or two words describing the right background music (e.g. upbeat corporate, calm piano, cinematic inspiring)", "titles": [a 2-5 word on-screen title per scene]}` }], { maxTokens: 800, temperature: 0.3 });
    const t = r.text.replace(/^```(?:json)?|```$/g, '').trim(); const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    return { queries: j.queries || [], mood: j.mood || '', titles: j.titles || [] };
  } catch { return { queries: scenes.map(s => (s.match(/\b[A-Za-z]{5,}\b/g) || ['abstract']).slice(0, 3).join(' ')), mood: '', titles: [] }; }
}
async function pexelsClip(query, aspect, dir, i) {
  const key = await settings.get('PEXELS_API_KEY'); if (!key || !query) return null;
  const orientation = aspect === '9:16' ? 'portrait' : aspect === '1:1' ? 'square' : 'landscape';
  try {
    const r = await fetch(`https://api.pexels.com/videos/search?per_page=5&size=medium&orientation=${orientation}&query=${encodeURIComponent(query)}`, { headers: { authorization: key } });
    const d = await r.json();
    for (const v of d.videos || []) {
      const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.height >= 540).sort((a, b) => a.width * a.height - b.width * b.height);
      const f = files.find(x => Math.max(x.width, x.height) >= 960) || files[0];
      if (f) return { type: 'video', file: await download(f.link, join(dir, `pex${i}.mp4`)), credit: `Video by ${v.user?.name || 'Pexels'} on Pexels` };
    }
    const p = await (await fetch(`https://api.pexels.com/v1/search?per_page=3&orientation=${orientation}&query=${encodeURIComponent(query)}`, { headers: { authorization: key } })).json();
    const photo = p.photos?.[0];
    if (photo) return { type: 'image', file: await download(photo.src.large, join(dir, `pex${i}.jpg`)), credit: `Photo by ${photo.photographer} on Pexels` };
  } catch {}
  return null;
}
async function musicBed(c, mood, total, dir, ff) {
  if (c.music === 'none') return null;
  const query = (c.music || mood || 'upbeat corporate').replace(/lo-?fi/i, 'lofi');
  const key = await settings.get('FREESOUND_API_KEY');
  if (key) {
    try {
      const filter = encodeURIComponent(`license:"Creative Commons 0" duration:[${Math.min(30, Math.round(total))} TO 600]`);
      const r = await fetch(`https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query + ' music')}&filter=${filter}&sort=rating_desc&page_size=5&fields=id,name,username,previews,duration&token=${encodeURIComponent(key)}`);
      const d = await r.json(); const s = (d.results || []).find(x => x.previews?.['preview-hq-mp3']);
      if (s) return { file: await download(s.previews['preview-hq-mp3'], join(dir, 'music.mp3')), credit: `Music: "${s.name}" by ${s.username} (Freesound, CC0)`, source: 'freesound', mood: query };
    } catch {}
  }
  // generated ambient bed matched to the mood: brighter chord for upbeat moods, darker for calm/cinematic
  const bright = /upbeat|energetic|happy|corporate|electronic|hip hop/i.test(query);
  const freqs = bright ? [261.63, 329.63, 392.0, 523.25] : [220.0, 261.63, 329.63, 440.0];
  const expr = freqs.map((f, i) => `${(0.18 / (i + 1)).toFixed(3)}*sin(2*PI*${f}*t)*(0.6+0.4*sin(2*PI*${bright ? 0.5 : 0.12}*t+${i}))`).join('+');
  const out = join(dir, 'music.m4a');
  await run(ff, ['-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${Math.ceil(total) + 2}`, '-af', `afade=t=in:d=2,afade=t=out:st=${Math.max(0, Math.ceil(total) - 1)}:d=3,lowpass=f=${bright ? 3000 : 1500}`, '-c:a', 'aac', '-b:a', '96k', out]);
  return { file: out, credit: 'Music: generated ambient bed (OMNIA IQ)', source: 'generated', mood: query };
}

export async function produce(task, script, media = [], { event = async () => {}, cancelled = async () => false } = {}) {
  const ff = await ffmpegPath(); if (!ff) throw new Error('FFmpeg is not available in this deployment.');
  const c = contract(task.title, task.instructions);
  const [W, H] = SIZES[c.aspect];
  const dir = await mkdtemp(join(tmpdir(), 'omnia-v-'));
  try {
    const scenes = splitScenes(script, c.duration);
    await event('production', 'running', `Storyboard · ${scenes.length} scenes · ${c.aspect} · ${c.language_name}`);
    const plan = await planVisuals(script, scenes, c);
    const speech = await settings.getMany(['OMNIA_SPEECH_PROVIDER', 'OMNIA_SPEECH_VOICE']);
    // narration per scene keeps captions and visuals in sync with the voice
    const voice = []; let engine = '';
    for (let i = 0; i < scenes.length; i++) {
      if (await cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const n = await narrate(scenes[i], { locale: c.locale, gender: c.gender, provider: speech.OMNIA_SPEECH_PROVIDER || 'auto' });
      const f = join(dir, `n${i}.mp3`); await writeFile(f, n.audio); engine = `${n.engine} · ${n.voice}`;
      voice.push({ file: f, seconds: Math.max(2.5, (await duration(ff, f)) + 0.35) });
    }
    await event('narration', 'completed', `Narration recorded · ${engine} · ${voice.reduce((a, v) => a + v.seconds, 0).toFixed(1)}s`);
    // visuals: creator media first, then stock footage, then designed cards
    const own = [];
    for (const m of media.filter(m => /image|video/.test(m.media_type))) {
      try { own.push({ type: m.media_type, file: (await writeFile(join(dir, `own${own.length}`), await store.read(m.local_file_id)), join(dir, `own${own.length}`)), credit: '' }); } catch {}
    }
    const visuals = [], credits = new Set();
    for (let i = 0; i < scenes.length; i++) {
      const v = own[i] || await pexelsClip(plan.queries[i], c.aspect, dir, i) || { type: 'card' };
      if (v.credit) credits.add(v.credit); visuals.push(v);
    }
    await event('visuals', 'completed', `Visuals · ${visuals.filter(v => v.type !== 'card' && !v.credit).length} yours · ${visuals.filter(v => v.credit).length} stock · ${visuals.filter(v => v.type === 'card').length} designed`);
    const total = voice.reduce((a, v) => a + v.seconds, 0);
    const music = await musicBed(c, plan.mood, total, dir, ff).catch(() => null);
    if (music) { credits.add(music.credit); await event('music', 'completed', `Music matched · ${music.mood} · ${music.source}`); }

    // render each scene
    const capW = c.aspect === '16:9' ? 52 : 30, fs = c.aspect === '16:9' ? 34 : 36;
    const parts = [];
    for (let i = 0; i < scenes.length; i++) {
      if (await cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const v = visuals[i], d = voice[i].seconds.toFixed(2), out = join(dir, `s${i}.mp4`);
      const cap = join(dir, `c${i}.txt`), ttl = join(dir, `t${i}.txt`);
      await writeFile(cap, wrap(scenes[i], capW).slice(0, 5).join('\n'));
      await writeFile(ttl, wrap(plan.titles[i] || (i === 0 ? task.title : ''), 22).join('\n'));
      const args = ['-y'];
      let vf;
      if (v.type === 'video') { args.push('-stream_loop', '-1', '-t', d, '-i', v.file); vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`; }
      else if (v.type === 'image') { args.push('-loop', '1', '-t', d, '-i', v.file); vf = `[0:v]scale=${Math.round(W * 1.12)}:${Math.round(H * 1.12)}:force_original_aspect_ratio=increase,crop=${W}:${H}:x='(in_w-out_w)/2*(1-t/${d})':y='(in_h-out_h)/2',setsar=1,fps=30`; }
      else { args.push('-f', 'lavfi', '-t', d, '-i', `color=c=${PALETTE[i % PALETTE.length]}:s=${W}x${H}:r=30`); vf = `[0:v]drawbox=x=0:y=ih*0.62:w=iw*(t/${d}):h=4:color=0xd9a632@0.9:t=fill,drawtext=fontfile='${FONT}':textfile='${ttl}':fontcolor=white:fontsize=${c.aspect === '16:9' ? 64 : 60}:line_spacing=10:x=(w-text_w)/2:y=h*0.3`; }
      if (v.type !== 'card') vf += `,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.18:t=fill`;
      if (c.captions) vf += `,drawtext=fontfile='${FONT}':textfile='${cap}':fontcolor=white:fontsize=${fs}:line_spacing=10:borderw=3:bordercolor=black@0.85:box=1:boxcolor=black@0.35:boxborderw=14:x=(w-text_w)/2:y=h-text_h-${c.aspect === '16:9' ? 60 : 180}`;
      vf += `,fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, voice[i].seconds - 0.25).toFixed(2)}:d=0.25[v]`;
      args.push('-i', voice[i].file, '-filter_complex', vf + `;[1:a]apad,atrim=0:${d},aresample=44100[a]`, '-map', '[v]', '-map', '[a]', '-t', d, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', out);
      await run(ff, args);
      parts.push(out);
      await event('rendering', 'running', `Rendered scene ${i + 1} of ${scenes.length}`);
    }
    await writeFile(join(dir, 'list.txt'), parts.map(p => `file '${p}'`).join('\n'));
    const joined = join(dir, 'joined.mp4'), final = join(dir, 'final.mp4');
    await run(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', joined]);
    if (music) await run(ff, ['-y', '-i', joined, '-stream_loop', '-1', '-i', music.file, '-filter_complex', `[1:a]volume=0.5,aresample=44100[m];[m][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];[duck]volume=0.35,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final]);
    else await run(ff, ['-y', '-i', joined, '-c', 'copy', '-movflags', '+faststart', final]);
    await event('rendering', 'completed', `Video rendered · ${total.toFixed(1)}s · ${W}x${H}`);
    return { video: await readFile(final), seconds: total, scenes, plan, credits: [...credits], aspect: c.aspect, engine, music: music && { source: music.source, mood: music.mood } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
