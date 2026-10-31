import { SarvamAIClient } from 'sarvamai';
import { timeCall } from './ai-ops-metrics.js';

let client: SarvamAIClient | null = null;

export function getSarvam(): SarvamAIClient | null {
  if (client) return client;
  const key = process.env.SARVAM_API_KEY;
  if (!key || key === 'your-sarvam-api-key-here') return null;
  client = new SarvamAIClient({ apiSubscriptionKey: key });
  return client;
}

export const SARVAM_CHAT_MODEL = (process.env.SARVAM_CHAT_MODEL || 'sarvam-105b-conversations') as 'sarvam-105b' | 'sarvam-105b-conversations';

export const SUPPORTED_LANGUAGES: Record<string, string> = {
  'en-IN': 'English',
  'hi-IN': 'Hindi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'kn-IN': 'Kannada',
  'bn-IN': 'Bengali',
  'mr-IN': 'Marathi',
  'gu-IN': 'Gujarati',
  'ml-IN': 'Malayalam',
  'pa-IN': 'Punjabi',
  'od-IN': 'Odia',
};

export function isSupportedLanguage(code: string): code is keyof typeof SUPPORTED_LANGUAGES {
  return code in SUPPORTED_LANGUAGES;
}

export async function sarvamChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  temperature = 0.3,
): Promise<string> {
  const sarvam = getSarvam();
  if (!sarvam) throw new Error('Sarvam API key not configured');

  const charsIn = messages.reduce((s, m) => s + m.content.length, 0);
  const res = await timeCall('chat', async () => sarvam.chat.completions({
    model: SARVAM_CHAT_MODEL,
    messages,
    temperature,
    max_tokens: 1024,
  }), (r) => ({
    tokensIn: Math.ceil(charsIn / 4),
    tokensOut: Math.ceil(((r as any).choices?.[0]?.message?.content?.length ?? 0) / 4),
  }));

  let text = res.choices[0]?.message?.content ?? '';
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return text;
}
