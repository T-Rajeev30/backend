import type { SarvamAIClient } from 'sarvamai';
import { getSarvam } from './sarvam-client.js';
import { timeCall } from './ai-ops-metrics.js';

export interface VoiceProvider {
  transcribe(buffer: Buffer, mimeType: string, language?: string): Promise<{ transcript: string; languageCode: string }>;
  speak(text: string, language: string): Promise<{ audioBase64: string; mimeType: string }>;
}

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

/** Adapter around Sarvam's speech API. Routes depend on VoiceProvider, not the SDK. */
export class SarvamVoiceAdapter implements VoiceProvider {
  constructor(private readonly client: SarvamAIClient) {}

  async transcribe(
    buffer: Buffer,
    mimeType: string,
    language?: string,
  ): Promise<{ transcript: string; languageCode: string }> {
    const filename = mimeType.includes('wav') ? 'audio.wav'
      : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'audio.mp3'
      : mimeType.includes('webm') ? 'audio.webm'
      : mimeType.includes('ogg') ? 'audio.ogg'
      : 'audio.wav';

    const response = await timeCall('stt', async () => this.client.speechToText.transcribe({
      file: { data: buffer, filename, contentType: mimeType },
      model: 'saaras:v3',
      mode: 'transcribe',
      ...(language && language !== 'auto' ? { language_code: language as any } : {}),
    }), () => ({ chars: buffer.length }));

    return {
      transcript: response.transcript,
      languageCode: response.language_code || language || 'unknown',
    };
  }

  async speak(text: string, language: string): Promise<{ audioBase64: string; mimeType: string }> {
    const truncated = truncateAtSentence(text, 1500);
    const response = await timeCall('tts', async () => this.client.textToSpeech.convert({
      text: truncated,
      language_code: language as any,
      model: TTS_MODEL,
      speaker: TTS_SPEAKER,
    }), () => ({ chars: truncated.length }));

    return { audioBase64: response.audios[0] || '', mimeType: 'audio/wav' };
  }
}

function getVoiceProvider(): VoiceProvider | null {
  const client = getSarvam();
  return client ? new SarvamVoiceAdapter(client) : null;
}

// Keep stable service exports while allowing another authorized provider to
// implement the same interface later (including a device playback adapter).
export async function transcribe(
  buffer: Buffer,
  mimeType: string,
  language?: string,
): Promise<{ transcript: string; languageCode: string }> {
  const provider = getVoiceProvider();
  if (!provider) throw new Error('Sarvam API key not configured');
  return provider.transcribe(buffer, mimeType, language);
}

export async function speak(
  text: string,
  language: string,
): Promise<{ audioBase64: string; mimeType: string }> {
  const provider = getVoiceProvider();
  if (!provider) throw new Error('Sarvam API key not configured');
  return provider.speak(text, language);
}
