// Narration voices for the cloud version: free Google voices, or ElevenLabs (official API, your key).
import { randomUUID } from 'node:crypto';
import { googleTTS } from '../speech.js';
import * as settings from '../settings.js';

async function elevenTTS(text, gender) {
  const s = await settings.getMany(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MALE_VOICE_ID', 'ELEVENLABS_FEMALE_VOICE_ID', 'ELEVENLABS_MODEL']);
  if (!s.ELEVENLABS_API_KEY) throw new Error('ElevenLabs is not configured');
  const voice = (gender === 'male' && s.ELEVENLABS_MALE_VOICE_ID) || (gender === 'female' && s.ELEVENLABS_FEMALE_VOICE_ID) || s.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': s.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: s.ELEVENLABS_MODEL || 'eleven_multilingual_v2' }) });
  if (!r.ok) throw new Error(`ElevenLabs returned ${r.status}`);
  return { audio: Buffer.from(await r.arrayBuffer()), voice };
}
// Returns { audio (mp3 Buffer), engine, voice }.
export async function narrate(text, { locale = 'en-US', gender = '', provider = 'auto' } = {}) {
  if (process.env.OMNIA_MOCK_TTS) { // local tests only: a tone as long as the words would take to say
    const { ffmpegPath, run } = await import('../media.js'); const { readFile, rm } = await import('node:fs/promises');
    const f = `/tmp/mock-${randomUUID()}.mp3`, secs = Math.max(1, String(text).split(/\s+/).length * 0.4);
    await run(await ffmpegPath(), ['-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${secs}`, '-q:a', '6', f]);
    const audio = await readFile(f); await rm(f, { force: true }); return { audio, engine: 'mock', voice: 'tone' };
  }
  if (provider === 'elevenlabs' || (provider === 'auto' && await settings.get('ELEVENLABS_API_KEY'))) {
    try { const e = await elevenTTS(text, gender); return { audio: e.audio, engine: 'elevenlabs', voice: e.voice }; } catch (e) { if (provider === 'elevenlabs') throw e; }
  }
  return { audio: await googleTTS(text, locale), engine: 'gtts', voice: `Google ${locale}` };
}
