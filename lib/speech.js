// Free online text-to-speech (Google voices); ElevenLabs is used through its official API with your key.
import { json, fail } from './http.js';
import * as settings from './settings.js';
const GTTS_LANGS = { 'en-US': 'en', 'en-GB': 'en-GB', 'fil-PH': 'tl', 'tl-PH': 'tl', 'es-ES': 'es', 'fr-FR': 'fr', 'de-DE': 'de', 'it-IT': 'it', 'pt-BR': 'pt', 'nl-NL': 'nl', 'ru-RU': 'ru', 'pl-PL': 'pl', 'tr-TR': 'tr', 'ar-SA': 'ar', 'hi-IN': 'hi', 'zh-CN': 'zh-CN', 'ja-JP': 'ja', 'ko-KR': 'ko', 'vi-VN': 'vi', 'sw-KE': 'sw' };
const lang = locale => GTTS_LANGS[locale] || String(locale || 'en').split('-')[0];
function chunks(text, max = 190) {
  const out = []; let cur = '';
  for (const part of String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?,;:])\s+/)) {
    if ((cur + ' ' + part).trim().length <= max) cur = (cur + ' ' + part).trim();
    else { if (cur) out.push(cur); let p = part; while (p.length > max) { const i = p.lastIndexOf(' ', max) > 0 ? p.lastIndexOf(' ', max) : max; out.push(p.slice(0, i)); p = p.slice(i).trim(); } cur = p; }
  }
  if (cur) out.push(cur); return out;
}
export async function googleTTS(text, locale = 'en-US') {
  const parts = [];
  for (const q of chunks(text)) {
    const r = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang(locale))}&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://translate.google.com/' } });
    if (!r.ok) throw new Error(`Google voices returned ${r.status}`);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(parts); // MP3 frames concatenate cleanly
}
export async function synthesize(text, { locale } = {}) {
  locale ||= await settings.get('OMNIA_SPEECH_LOCALE', 'en-US');
  return { audio: await googleTTS(text, locale), mime: 'audio/mpeg', engine: 'gtts' };
}
export async function speechRoutes(p, method, b, url) {
  const { narrate } = await import('./video/tts.js');
  if (p === 'media/free-speech/voices') {
    const locale = url.searchParams.get('locale') || 'en-US';
    return json({ voices: [{ name: `Google ${locale}`, gender: 'neutral', quality: 'standard', locale }], engine: 'gtts' });
  }
  if (p === 'media/free-speech/diagnostics') return json({ ok: true, engines: ['gtts', 'elevenlabs'] });
  if (p === 'media/free-speech/piper-voice') return fail(400, 'Offline Piper voices are only available in the desktop version.');
  if (p === 'media/free-speech/test' || p.startsWith('media/test-')) {
    const s = await settings.getMany(['OMNIA_SPEECH_LOCALE', 'OMNIA_SPEECH_VOICE', 'OMNIA_SPEECH_PROVIDER']);
    const gender = p.includes('male-voice') ? (p.includes('female') ? 'female' : 'male') : '';
    const n = await narrate('Hello! This is OMNIA IQ, your creative studio. Your narration voice is ready.', { locale: b.locale || s.OMNIA_SPEECH_LOCALE || 'en-US', gender, provider: b.engine || s.OMNIA_SPEECH_PROVIDER || 'auto' });
    return new Response(n.audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-omnia-voice': `${n.engine}:${n.voice}` } });
  }
  if (p === 'media/voices' || p === 'media/male-voice') return json({ voices: [], engine: 'gtts' });
  return null;
}
