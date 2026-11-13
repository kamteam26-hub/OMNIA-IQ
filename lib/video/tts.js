// Free narration voices: Microsoft Edge neural voices (online), falling back to Google voices.
import { createHash, randomUUID } from 'node:crypto';
import { googleTTS } from '../speech.js';

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const GEC_VERSION = '1-130.0.2849.68';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
function gec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600; ticks -= ticks % 300;
  return createHash('sha256').update(`${BigInt(ticks) * 10000000n}${TRUSTED}`, 'ascii').digest('hex').toUpperCase();
}
export const DEFAULT_VOICES = {
  'en-US': { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' }, 'en-GB': { female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' },
  'fil-PH': { female: 'fil-PH-BlessicaNeural', male: 'fil-PH-AngeloNeural' }, 'es-ES': { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
  'fr-FR': { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' }, 'de-DE': { female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' },
  'it-IT': { female: 'it-IT-ElsaNeural', male: 'it-IT-DiegoNeural' }, 'pt-BR': { female: 'pt-BR-FranciscaNeural', male: 'pt-BR-AntonioNeural' },
  'nl-NL': { female: 'nl-NL-ColetteNeural', male: 'nl-NL-MaartenNeural' }, 'ru-RU': { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
  'pl-PL': { female: 'pl-PL-ZofiaNeural', male: 'pl-PL-MarekNeural' }, 'tr-TR': { female: 'tr-TR-EmelNeural', male: 'tr-TR-AhmetNeural' },
  'ar-SA': { female: 'ar-SA-ZariyahNeural', male: 'ar-SA-HamedNeural' }, 'hi-IN': { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' },
  'zh-CN': { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' }, 'ja-JP': { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  'ko-KR': { female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' }, 'vi-VN': { female: 'vi-VN-HoaiMyNeural', male: 'vi-VN-NamMinhNeural' },
  'sw-KE': { female: 'sw-KE-ZuriNeural', male: 'sw-KE-RafikiNeural' },
};
export function pickVoice(locale, gender, chosen) {
  if (chosen && /Neural$/.test(chosen) && chosen.startsWith(locale.split('-')[0])) return chosen;
  const v = DEFAULT_VOICES[locale] || DEFAULT_VOICES[Object.keys(DEFAULT_VOICES).find(k => k.startsWith(locale.split('-')[0])) || 'en-US'];
  return gender === 'male' ? v.male : v.female;
}
const xml = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function edgeTTS(text, voice, { rate = '+0%', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${randomUUID().replace(/-/g, '')}`;
    let ws;
    try { ws = new WebSocket(url, { headers: { 'User-Agent': UA, Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', Pragma: 'no-cache', 'Cache-Control': 'no-cache' } }); }
    catch (e) { return reject(e); }
    ws.binaryType = 'arraybuffer';
    const chunks = []; const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('Edge voice timed out')); }, timeoutMs);
    const stamp = () => new Date().toString();
    ws.onopen = () => {
      ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      const lang = voice.split('-').slice(0, 2).join('-');
      ws.send(`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${xml(text)}</prosody></voice></speak>`);
    };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') { if (ev.data.includes('Path:turn.end')) { clearTimeout(timer); ws.close(); resolve(Buffer.concat(chunks)); } return; }
      const buf = Buffer.from(ev.data), hl = buf.readUInt16BE(0), header = buf.subarray(2, 2 + hl).toString();
      if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + hl));
    };
    ws.onerror = e => { clearTimeout(timer); reject(new Error('Edge voice connection failed: ' + (e.message || e.type || 'error'))); };
    ws.onclose = () => { clearTimeout(timer); if (!chunks.length) reject(new Error('Edge voice returned no audio')); };
  });
}
export async function edgeVoices(locale) {
  const r = await fetch(`https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Edge voice list returned ${r.status}`);
  const list = await r.json();
  return list.filter(v => !locale || v.Locale.toLowerCase().startsWith(locale.toLowerCase()) || v.Locale.toLowerCase().startsWith(locale.split('-')[0].toLowerCase() + '-'))
    .map(v => ({ name: v.ShortName, gender: (v.Gender || '').toLowerCase(), quality: 'neural', locale: v.Locale }));
}
// Narration with automatic fallback. Returns { audio (mp3 Buffer), engine, voice }.
export async function narrate(text, { locale = 'en-US', gender = '', voice = '', provider = 'auto' } = {}) {
  if (process.env.OMNIA_MOCK_TTS) { // local tests only: a tone as long as the words would take to say
    const { ffmpegPath, run } = await import('../media.js'); const { readFile, rm } = await import('node:fs/promises');
    const f = `/tmp/mock-${randomUUID()}.mp3`, secs = Math.max(1, String(text).split(/\s+/).length * 0.4);
    await run(await ffmpegPath(), ['-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${secs}`, '-q:a', '6', f]);
    const audio = await readFile(f); await rm(f, { force: true }); return { audio, engine: 'mock', voice: 'tone' };
  }
  if (provider !== 'gtts') {
    const v = pickVoice(locale, gender, voice);
    try { return { audio: await edgeTTS(text, v), engine: 'edge_tts', voice: v }; } catch (e) { if (provider === 'edge_tts') throw e; }
  }
  return { audio: await googleTTS(text, locale), engine: 'gtts', voice: `Google ${locale}` };
}
