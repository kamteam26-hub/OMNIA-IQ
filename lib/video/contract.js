// Reads what the creator asked for (duration, language, format, voice, music) from the brief.
// Simplified cloud port of v88.5 context_engine / prompt_interpreter / script quality gate.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const LANGS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'languages.json'), 'utf8'));
const EXTRA = [{ code: 'tl', name: 'Filipino', locale: 'fil-PH', alias: /\b(filipino|tagalog)\b/i }];

export function contract(title, instructions = '') {
  const text = `${title}\n${instructions}`;
  let seconds = null, m;
  if ((m = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)?\s*(minutes?|mins?|m)\b/i))) seconds = parseFloat(m[1]) * 60;
  else if ((m = text.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i))) seconds = parseFloat(m[1]);
  if (seconds) seconds = Math.max(10, Math.min(seconds, 180)); // serverless render budget
  let lang = LANGS[0];
  for (const l of [...EXTRA, ...LANGS]) if ((l.alias || new RegExp(`\\b(in|language:?)\\s+${l.name}\\b`, 'i')).test(text)) { lang = l; break; }
  const vertical = /\b(9:16|vertical|reels?|tiktok|shorts|story|stories)\b/i.test(text) && !/\b16:9\b/.test(text);
  const square = /\b(1:1|square)\b/i.test(text);
  const gender = /\b(female|woman|women's)\s+(voice|narrator)/i.test(text) ? 'female' : /\b(male|man|men's)\s+(voice|narrator)/i.test(text) ? 'male' : '';
  const noMusic = /\b(no|without)\s+(background\s+)?music\b/i.test(text);
  const captions = !/\b(no|without)\s+(captions|subtitles)\b/i.test(text);
  const target = Math.round((seconds || 45) * (lang.code === 'en' ? 2.4 : 2.1));
  const music = (text.match(/\b(upbeat|energetic|calm|relaxing|cinematic|epic|inspiring|corporate|happy|sad|dramatic|ambient|lofi|lo-fi|acoustic|electronic|piano|hip hop|jazz)\b/i) || [])[1] || '';
  const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 10);
  return { requested_duration: seconds, duration: seconds || 45, language_name: lang.name, language_code: lang.code, locale: lang.locale, target_words: target,
    aspect: vertical ? '9:16' : square ? '1:1' : '16:9', gender, music: noMusic ? 'none' : music, captions, fingerprint };
}

export const normalize = s => String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
export const digest = s => createHash('sha256').update(normalize(s), 'utf8').digest('hex');
export const wordCount = s => (normalize(s).match(/\S+/g) || []).length;

const DIRECTIONS = /(^|\n)\s*(\[[^\]]*\]|\([^)]*(music|sfx|pause|cut|scene|visual|camera)[^)]*\)|(scene|shot|narrator|voice ?over|vo|b-roll|on-screen text|music|sfx)\s*\d*\s*:)/i;
export function assess(script, expected, seconds) {
  const words = wordCount(script), blocking = [], advisory = [];
  if (!words) blocking.push('the script is empty');
  if (DIRECTIONS.test(script)) blocking.push('it contains production directions (scene labels, brackets or speaker names) that would be read aloud');
  if (/https?:\/\//.test(script)) advisory.push('it contains a web address that will be spoken letter by letter');
  if (expected && words < expected * 0.65) advisory.push(`it is too short (${words} words, about ${expected} expected)`);
  if (expected && words > expected * 1.4) advisory.push(`it is too long (${words} words, about ${expected} expected)`);
  return { ok: !blocking.length && !advisory.length, blocking, advisory, reasons: [...blocking, ...advisory], word_count: words };
}
export function reviewPayload(task, script) {
  const c = contract(task.title, task.instructions), v = assess(script, c.target_words, c.requested_duration);
  const numbers = [...new Set(normalize(script).match(/\b\d[\d,.:%$]*\b|\b[A-Z]{2,}\b/g) || [])].slice(0, 20);
  return { task_id: task.id, script: normalize(script), script_sha256: digest(script), word_count: v.word_count, language: c.language_name, expected_words: c.target_words, notes: v.reasons, decisions: ['approve', 'edit', 'reject'],
    delivery_brief: { language: c.language_name, pace: c.duration <= 30 ? 'brisk' : 'conversational', voice: c.gender || 'auto', target_seconds: c.duration },
    spoken_text_audit: numbers.map(t => ({ text: t, note: 'Check how this is read aloud' })), before_synthesis: ['Numbers, dates and abbreviations read naturally', 'No stage directions in the narration', 'Names are spelled the way they should be pronounced'] };
}
