// In-memory metrics for AI operations. Resets on server restart.
// For demo purposes only — production would use a time-series DB.

interface Call {
  kind: 'chat' | 'tts' | 'stt' | 'translate' | 'transliterate';
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  chars?: number;
  success: boolean;
  timestamp: number;
}

const calls: Call[] = [];
const MAX_CALLS = 2000;

// Sarvam pricing (approximate, in INR), from public docs 2026
const PRICING = {
  chat: { perMillionIn: 50, perMillionOut: 100 },  // ₹50 / M input tokens, ₹100 / M output
  tts: { perMillionChars: 400 },                    // ₹400 / M characters
  stt: { perMinute: 1.5 },                          // ₹1.5 / minute
  translate: { perMillionChars: 100 },              // ₹100 / M characters
  transliterate: { perMillionChars: 50 },
};

export function recordCall(c: Omit<Call, 'timestamp'>) {
  calls.push({ ...c, timestamp: Date.now() });
  if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
}

function estimateCost(c: Call): number {
  if (c.kind === 'chat') {
    const inCost = ((c.tokensIn || 0) / 1_000_000) * PRICING.chat.perMillionIn;
    const outCost = ((c.tokensOut || 0) / 1_000_000) * PRICING.chat.perMillionOut;
    return inCost + outCost;
  }
  if (c.kind === 'tts') return ((c.chars || 0) / 1_000_000) * PRICING.tts.perMillionChars;
  if (c.kind === 'stt') return (((c.chars || 0) / 1000) / 60) * PRICING.stt.perMinute; // chars ~ ms audio
  if (c.kind === 'translate') return ((c.chars || 0) / 1_000_000) * PRICING.translate.perMillionChars;
  if (c.kind === 'transliterate') return ((c.chars || 0) / 1_000_000) * PRICING.transliterate.perMillionChars;
  return 0;
}

export function getMetrics() {
  const now = Date.now();
  const last24h = calls.filter((c) => now - c.timestamp < 86_400_000);

  const totalCalls = last24h.length;
  const successCalls = last24h.filter((c) => c.success).length;
  const fallbackCount = totalCalls - successCalls;

  const totalLatency = last24h.reduce((s, c) => s + c.latencyMs, 0);
  const avgLatencyMs = totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0;

  const totalCost = last24h.reduce((s, c) => s + estimateCost(c), 0);
  const estCostInr = parseFloat(totalCost.toFixed(2));

  const byKind: Record<string, { calls: number; avgLatency: number; cost: number }> = {};
  for (const c of last24h) {
    if (!byKind[c.kind]) byKind[c.kind] = { calls: 0, avgLatency: 0, cost: 0 };
    byKind[c.kind].calls += 1;
    byKind[c.kind].avgLatency += c.latencyMs;
    byKind[c.kind].cost += estimateCost(c);
  }
  for (const k of Object.keys(byKind)) {
    byKind[k].avgLatency = Math.round(byKind[k].avgLatency / byKind[k].calls);
    byKind[k].cost = parseFloat(byKind[k].cost.toFixed(2));
  }

  return {
    windowHours: 24,
    totalCalls,
    successCalls,
    fallbackCount,
    successRatePercent: totalCalls > 0 ? parseFloat(((successCalls / totalCalls) * 100).toFixed(1)) : 0,
    avgLatencyMs,
    estCostInr,
    byKind,
    recent: last24h.slice(-20).map((c) => ({
      kind: c.kind, latencyMs: c.latencyMs, success: c.success, ago: Math.round((now - c.timestamp) / 1000) + 's',
    })),
  };
}

export async function timeCall<T>(
  kind: Call['kind'],
  fn: () => Promise<T>,
  getMeta?: (result: T) => Partial<Pick<Call, 'tokensIn' | 'tokensOut' | 'chars'>>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const meta = getMeta ? getMeta(result) : {};
    recordCall({ kind, latencyMs: Date.now() - start, success: true, ...meta });
    return result;
  } catch (e) {
    recordCall({ kind, latencyMs: Date.now() - start, success: false });
    throw e;
  }
}
