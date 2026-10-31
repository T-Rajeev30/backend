import { getSarvam } from './sarvam-client.js';
import { timeCall } from './ai-ops-metrics.js';

const TTS_MODEL = (process.env.SARVAM_TTS_MODEL || 'bulbul:v3') as any;
const TTS_SPEAKER = (process.env.SARVAM_TTS_SPEAKER || 'shubh') as any;

function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
    truncated.lastIndexOf('।'),
  );
  if (lastSentenceEnd > maxLen * 0.5) return truncated.slice(0, lastSentenceEnd + 1);
  return truncated;
}

export async function transcribe(
  buffer: Buffer,
  mimeType: string,
  language?: string,
): Promise<{ transcript: string; languageCode: string }> {
  const sarvam = getSarvam();
  if (!sarvam) throw new Error('Sarvam API key not configured');

  const ext = mimeType.includes('wav') ? 'audio.wav'
    : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'audio.mp3'
    : mimeType.includes('webm') ? 'audio.webm'
    : mimeType.includes('ogg') ? 'audio.ogg'
    : 'audio.wav';

  const res = await timeCall('stt', async () => sarvam.speechToText.transcribe({
    file: { data: buffer, filename: ext, contentType: mimeType },
    model: 'saaras:v3',
    mode: 'transcribe',
    ...(language && language !== 'auto' ? { language_code: language as any } : {}),
  }), () => ({ chars: buffer.length }));

  return {
    transcript: res.transcript,
    languageCode: res.language_code || language || 'unknown',
  };
}

export async function speak(
  text: string,
  language: string,
): Promise<{ audioBase64: string; mimeType: string }> {
  const sarvam = getSarvam();
  if (!sarvam) throw new Error('Sarvam API key not configured');

  const truncated = truncateAtSentence(text, 1500);

  const res = await timeCall('tts', async () => sarvam.textToSpeech.convert({
    text: truncated,
    language_code: language as any,
    model: TTS_MODEL,
    speaker: TTS_SPEAKER,
  }), () => ({ chars: truncated.length }));

  return {
    audioBase64: res.audios[0] || '',
    mimeType: 'audio/wav',
  };
}
