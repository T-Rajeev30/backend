import { getSarvam } from './sarvam-client.js';
import { timeCall } from './ai-ops-metrics.js';

const cache = new Map<string, string>();
const MAX_CACHE = 500;
const CHUNK_SIZE = 900;

function cacheKey(target: string, text: string): string {
  return target + '\0' + text;
}

function evictIfNeeded() {
  if (cache.size <= MAX_CACHE) return;
  const first = cache.keys().next().value!;
  cache.delete(first);
}

function splitText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > CHUNK_SIZE) {
    let splitAt = -1;
    for (let i = CHUNK_SIZE; i >= CHUNK_SIZE - 200 && i >= 0; i--) {
      if (remaining[i] === '\n' || remaining[i] === '.' || remaining[i] === '!' || remaining[i] === '?') {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt === -1) splitAt = CHUNK_SIZE;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Preserves ₹NNN or ₹N,NNN patterns across translation (Sarvam strips ₹).
function reinjectCurrencySymbols(original: string, translated: string): string {
  const matches = original.match(/₹\s*[\d,]+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return translated;
  let result = translated;
  for (const m of matches) {
    const num = m.replace(/[₹\s]/g, '');
    // Find first occurrence of the number not already prefixed by ₹
    const re = new RegExp(`(?<!₹\\s?)${num.replace(/[.,]/g, '\\$&')}`);
    if (re.test(result)) {
      result = result.replace(re, `₹${num}`);
    }
  }
  return result;
}

export async function translateText(
  text: string,
  target: string,
  source = 'auto',
): Promise<string> {
  if (target === 'en-IN' || !getSarvam()) return text;

  const key = cacheKey(target, text);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const sarvam = getSarvam()!;
  const chunks = splitText(text);
  const translated: string[] = [];

  for (const chunk of chunks) {
    const res = await timeCall('translate', async () => sarvam.text.translate({
      input: chunk,
      source_language_code: source as any,
      target_language_code: target as any,
      model: 'mayura:v1',
    }), () => ({ chars: chunk.length }));
    translated.push(reinjectCurrencySymbols(chunk, res.translated_text));
  }

  const result = translated.join('');
  evictIfNeeded();
  cache.set(key, result);
  return result;
}

export async function translateMany(
  texts: string[],
  target: string,
): Promise<string[]> {
  if (target === 'en-IN' || !getSarvam()) return texts;

  const unique = [...new Set(texts)];
  const resultMap = new Map<string, string>();
  const concurrency = 4;

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((t) => translateText(t, target)));
    batch.forEach((t, idx) => resultMap.set(t, results[idx]));
  }

  return texts.map((t) => resultMap.get(t) ?? t);
}

export async function translateObject<T extends Record<string, any>>(
  obj: T,
  target: string,
  keys: string[],
): Promise<T> {
  if (target === 'en-IN' || !getSarvam()) return obj;

  const result = { ...obj } as any;

  for (const key of keys) {
    if (!(key in result)) continue;
    const val = result[key];
    if (typeof val === 'string') {
      result[key] = await translateText(val, target);
    } else if (Array.isArray(val)) {
      result[key] = await Promise.all(
        val.map((item: any) => {
          if (typeof item === 'string') return translateText(item, target);
          if (typeof item === 'object' && item !== null) return translateObject(item, target, keys);
          return item;
        }),
      );
    } else if (typeof val === 'object' && val !== null) {
      result[key] = await translateObject(val, target, keys);
    }
  }

  return result;
}
