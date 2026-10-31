import { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import type { Types } from 'mongoose';
import type { WebSocket as ClientSocket } from 'ws';
import { getSarvam, isSupportedLanguage } from './sarvam-client.js';
import { authenticateRequest, getRequestMerchantId, hashToken } from '../db/helpers.js';
import { AuthSession } from '../db/models.js';
import { streamAssistantResponse } from './ai-service.js';
import { inferVoiceTool, runVoiceTool, voiceToolSchema } from './voice-tools.js';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws') as {
  WebSocketServer: new (options: Record<string, unknown>) => any;
  WebSocket: { OPEN: number };
};
const LANGS = new Set(['en-IN', 'hi-IN', 'kn-IN', 'auto']);
type TurnMessage = { role: 'user' | 'assistant'; content: string };

export async function authorizeVoiceConnection(request: { headers: Record<string, string | string[] | undefined> }, merchantId: string, origin: string | undefined, allowedOrigins: string[]) {
  if (!origin || !allowedOrigins.includes(origin)) throw Object.assign(new Error('Invalid voice origin'), { statusCode: 403 });
  const { user, session } = await authenticateRequest(request);
  const authorizedMerchantId = await getRequestMerchantId({ headers: request.headers, query: { merchantId } });
  const cookieHeader = request.headers.cookie;
  const cookieString = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader || '';
  let sessionToken = '';
  for (const part of cookieString.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === 'mga_session') { try { sessionToken = decodeURIComponent(value.join('=')); } catch { sessionToken = ''; } break; }
  }
  return { user, session, merchantId: authorizedMerchantId, sessionTokenHash: hashToken(sessionToken) };
}

export function isDuplicateFinal(previousText: string, previousAt: number, text: string, now = Date.now()) {
  return Boolean(text && text === previousText && now - previousAt < 2500);
}

export function resolveVoiceLanguage(preferred: string, detected?: string) {
  if (['en-IN', 'hi-IN', 'kn-IN'].includes(preferred)) return preferred;
  return detected && ['en-IN', 'hi-IN', 'kn-IN'].includes(detected) ? detected : 'en-IN';
}

export function trimVoiceHistory(history: TurnMessage[]) {
  return history.length > 12 ? history.slice(-12) : history;
}

export class VoiceTurnCancellation {
  private active: AbortController | null = null;
  attach(controller: AbortController) { this.active = controller; }
  interrupt() {
    if (!this.active) return false;
    this.active.abort(); this.active = null; return true;
  }
}

class AsyncTextQueue {
  private values: string[] = [];
  private waiters: Array<(value: IteratorResult<string>) => void> = [];
  private ended = false;
  push(value: string) {
    if (this.ended || !value) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }
  close() {
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<string>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

function safeSend(client: ClientSocket, value: unknown) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
}

function summarizeTool(tool: string, result: any, language: string): string {
  const inHindi = language === 'hi-IN';
  const inKannada = language === 'kn-IN';
  const label = (en: string, hi: string, kn: string) => inHindi ? hi : inKannada ? kn : en;
  if (tool === 'today_sales') return `${label('Today sales', 'आज की बिक्री', 'ಇಂದಿನ ಮಾರಾಟ')}: ₹${result.revenue} ${label('from', 'से', 'ರಿಂದ')} ${result.transactions} ${label('transactions', 'लेन-देन', 'ವಹಿವಾಟು')}.`;
  if (tool === 'historical_sales') return `${label('Revenue', 'बिक्री', 'ಆದಾಯ')} ${label('for the last', 'पिछले', 'ಕಳೆದ')} ${result.days} ${label('days', 'दिन', 'ದಿನಗಳಲ್ಲಿ')} ₹${result.currentRevenue}; ${label('previous period', 'पिछली अवधि', 'ಹಿಂದಿನ ಅವಧಿ')} ₹${result.previousRevenue}; ${label('change', 'बदलाव', 'ಬದಲಾವಣೆ')} ₹${result.changeAmount}.`;
  if (tool === 'gross_profit') return result.complete
    ? `${label('Estimated gross profit', 'अनुमानित सकल लाभ', 'ಅಂದಾಜು ಒಟ್ಟು ಲಾಭ')} ${label('over', 'पिछले', 'ಕಳೆದ')} ${result.days} ${label('days', 'दिन', 'ದಿನಗಳಲ್ಲಿ')}: ₹${result.grossProfit}. ${label('This excludes fixed overhead and taxes.', 'इसमें स्थिर खर्च और कर शामिल नहीं हैं।', 'ಇದರಲ್ಲಿ ಸ್ಥಿರ ವೆಚ್ಚ ಮತ್ತು ತೆರಿಗೆ ಸೇರಿಲ್ಲ.')}`
    : `${label('Some product costs are missing, so gross profit is incomplete.', 'कुछ उत्पादों की लागत उपलब्ध नहीं है, इसलिए सकल लाभ अधूरा है।', 'ಕೆಲವು ಉತ್ಪನ್ನಗಳ ವೆಚ್ಚ ಇಲ್ಲದಿರುವುದರಿಂದ ಒಟ್ಟು ಲಾಭ ಅಪೂರ್ಣವಾಗಿದೆ.')}`;
  if (tool === 'top_products') return result.products.length
    ? `${label('Top products by revenue', 'आय के अनुसार शीर्ष उत्पाद', 'ಆದಾಯದ ಪ್ರಕಾರ ಪ್ರಮುಖ ಉತ್ಪನ್ನಗಳು')}: ${result.products.map((item: any) => `${item.product}, ₹${item.revenue}`).join('; ')}.`
    : label('There are no sales in that period.', 'इस अवधि में बिक्री नहीं है।', 'ಆ ಅವಧಿಯಲ್ಲಿ ಮಾರಾಟ ಇಲ್ಲ.');
  if (tool === 'customer_segments') return `${label('Customer segments', 'ग्राहक समूह', 'ಗ್ರಾಹಕ ವಿಭಾಗಗಳು')}: ${Object.entries(result.segments).map(([key, count]) => `${key} ${count}`).join(', ')}. ${label('Eligible messaging audience', 'संदेश के लिए सहमति वाले ग्राहक', 'ಸಂದೇಶಕ್ಕೆ ಒಪ್ಪಿಗೆ ನೀಡಿದ ಗ್ರಾಹಕರು')}: ${result.eligibleMessagingAudience}.`;
  if (tool === 'campaign_performance') return result.campaigns.length
    ? result.campaigns.map((item: any) => item.simulated ? `${item.name}: ${label('simulated incremental gross profit', 'सिम्युलेटेड अतिरिक्त सकल लाभ', 'ಸಿಮ್ಯುಲೇಟೆಡ್ ಹೆಚ್ಚುವರಿ ಒಟ್ಟು ಲಾಭ')} ₹${item.incrementalGrossProfit}, ROI ${item.roiPercent}%.` : `${item.name}: ${item.status}.`).join(' ')
    : label('There are no campaigns yet.', 'अभी कोई अभियान नहीं है।', 'ಇನ್ನೂ ಯಾವುದೇ ಅಭಿಯಾನಗಳಿಲ್ಲ.');
  if (tool === 'opportunities') return result.opportunities.length
    ? result.opportunities.map((item: any) => `${item.title}. ${item.description}`).join(' ')
    : label('There are no current opportunities.', 'अभी कोई अवसर नहीं है।', 'ಪ್ರಸ್ತುತ ಯಾವುದೇ ಅವಕಾಶಗಳಿಲ್ಲ.');
  if (tool === 'merchant_settings') return `${result.name}, ${result.businessType}, ${result.city}. ${label('Data mode', 'डेटा मोड', 'ಡೇಟಾ ವಿಧಾನ')}: ${result.dataMode}.`;
  return `${label('Draft created', 'ड्राफ्ट बनाया गया', 'ಕರಡು ರಚಿಸಲಾಗಿದೆ')}: ${result.name}, ₹${result.budgetAmount}, ${result.status}. ${label('It is pending approval; nothing was sent or spent.', 'यह मंज़ूरी की प्रतीक्षा में है; कुछ भेजा या खर्च नहीं किया गया।', 'ಇದು ಅನುಮೋದನೆಗಾಗಿ ಕಾಯುತ್ತಿದೆ; ಏನನ್ನೂ ಕಳುಹಿಸಿಲ್ಲ ಅಥವಾ ಖರ್ಚು ಮಾಡಿಲ್ಲ.')}`;
}

async function streamTts(
  queue: AsyncTextQueue,
  language: string,
  client: ClientSocket,
  signal: AbortSignal,
  turnId: number,
): Promise<void> {
  const sarvam = getSarvam();
  if (!sarvam) throw new Error('Sarvam provider is not configured');
  const socket = await sarvam.textToSpeechStreaming.connect({
    model: (process.env.SARVAM_TTS_MODEL || 'bulbul:v3') as any,
    send_completion_event: 'true',
    reconnectAttempts: 0,
  });
  let completed = false;
  let resolveDone: () => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  socket.on('message', (message: any) => {
    if (signal.aborted) return;
    if (message?.type === 'audio' && typeof message.data?.audio === 'string') {
      safeSend(client, { type: 'audio_chunk', turnId, audio: message.data.audio, mimeType: 'audio/linear16', sampleRate: 16000 });
    } else if (message?.type === 'event' && message.data?.event_type === 'final') {
      completed = true; resolveDone();
    } else if (message?.type === 'error') rejectDone(new Error(message.data?.message || 'TTS provider error'));
  });
  socket.on('error', (error: Error) => rejectDone(error));
  socket.connect();
  await socket.waitForOpen();
  socket.configureConnection({
    language_code: language as any,
    speaker: (process.env.SARVAM_TTS_SPEAKER || 'shubh') as any,
    output_audio_codec: 'linear16',
    speech_sample_rate: 16000,
    min_buffer_size: 40,
    max_chunk_length: 180,
  });
  const abort = () => { socket.close(); resolveDone(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const text of queue) {
      if (signal.aborted) break;
      socket.convert(text);
    }
    if (!signal.aborted) {
      socket.flush();
      await Promise.race([done, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('TTS timed out')), 30_000))]);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    socket.close();
  }
}

function splitSentence(buffer: string): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let last = 0;
  const boundary = /[.!?।]\s+/gu;
  for (const match of buffer.matchAll(boundary)) {
    const end = (match.index || 0) + match[0].length;
    if (end >= 25) { ready.push(buffer.slice(last, end).trim()); last = end; }
  }
  return { ready, rest: buffer.slice(last) };
}

export function registerVoiceWebSocket(app: FastifyInstance, allowedOrigins: string[]) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 48 * 1024 });
  const userConnections = new Map<string, number>();
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/voice/stream') {
      socket.destroy(); return;
    }
    void (async () => {
      const origin = request.headers.origin;
      const { user, session, merchantId, sessionTokenHash } = await authorizeVoiceConnection(request, url.searchParams.get('merchantId') || '', origin, allowedOrigins);
      if (!LANGS.has(url.searchParams.get('language') || '')) throw Object.assign(new Error('language'), { statusCode: 4400 });
      const userKey = user._id.toString();
      if ((userConnections.get(userKey) || 0) >= 2) throw Object.assign(new Error('connection limit'), { statusCode: 4429 });
      userConnections.set(userKey, (userConnections.get(userKey) || 0) + 1);
      wss.handleUpgrade(request, socket, head, (client: ClientSocket) => {
        handleVoiceClient(client, merchantId, session.expiresAt, url.searchParams.get('language') || 'en-IN', sessionTokenHash, () => {
          const active = userConnections.get(userKey) || 1;
          if (active <= 1) userConnections.delete(userKey); else userConnections.set(userKey, active - 1);
        });
      });
    })().catch((error: any) => {
      const code = error.statusCode || 4401;
      try { socket.write(`HTTP/1.1 ${code === 4401 ? '401 Unauthorized' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`); } catch {}
      socket.destroy();
    });
  });
}

function handleVoiceClient(client: ClientSocket, merchantId: Types.ObjectId, expiresAt: Date, initialLanguage: string, sessionTokenHash: string, onClose: () => void) {
  const sarvam = getSarvam();
  if (!sarvam) { safeSend(client, { type: 'error', code: 'provider_unavailable', message: 'Sarvam is not configured.' }); client.close(1011, 'provider unavailable'); onClose(); return; }
  let language = initialLanguage;
  let ended = false;
  let currentTurn = 0;
  const turnCancellation = new VoiceTurnCancellation();
  let lastFinal = '';
  let lastFinalAt = 0;
  const history: TurnMessage[] = [];
  let sttPromise: Promise<any> | null = null;
  let sttSocket: any = null;

  const close = () => {
    if (ended) return;
    ended = true;
    turnCancellation.interrupt();
    try { sttSocket?.sendRealtimeEnd({}); sttSocket?.close(); } catch {}
    onClose();
  };
  const expiryTimer = setTimeout(() => { safeSend(client, { type: 'error', code: 'session_expired', message: 'Your session expired. Sign in again.' }); client.close(4401, 'session expired'); close(); }, Math.max(0, expiresAt.getTime() - Date.now()));
  const pingTimer = setInterval(() => { if (!ended) try { sttSocket?.sendRealtimePing({}); } catch {} }, 20_000);
  // Periodic re-validation: if the underlying session is revoked (logout) or
  // expires mid-call, close the voice connection and prevent further tool calls.
  const sessionRecheckTimer = setInterval(() => {
    if (ended) return;
    void AuthSession.findOne({ tokenHash: sessionTokenHash, expiresAt: { $gt: new Date() } }).select('_id').lean().then((row) => {
      if (ended) return;
      if (!row) {
        safeSend(client, { type: 'error', code: 'session_expired', message: 'Your session is no longer valid. Sign in again.' });
        try { client.close(4401, 'session invalid'); } catch {}
        close();
      }
    }).catch(() => {});
  }, 60_000);

  try {
    sttPromise = sarvam.speechToTextRealtimeStreaming.connect({
      'Api-Subscription-Key': process.env.SARVAM_API_KEY || '',
      language_code: (language === 'auto' ? 'auto' : language) as any,
      model: 'saaras:v3-realtime', stream_type: 'fast', endpointing: 'vad', encoding: 'linear16', sample_rate: '16000',
      silence_duration_ms: '700', min_speech_duration_ms: '250', reconnectAttempts: 0,
    });
  } catch (error) {
    safeSend(client, { type: 'error', code: 'provider_connect_failed', message: 'Could not connect to realtime speech recognition.' });
    client.close(1011, 'provider connect failed'); close(); return;
  }

  void sttPromise.then((connection: any) => {
    if (ended) { connection.close(); return; }
    sttSocket = connection;
    connection.on('message', (event: any) => {
      if (ended || !event) return;
      const type = event.event;
      if (type === 'session.begin') safeSend(client, { type: 'ready', provider: 'sarvam', mode: 'live' });
      else if (type === 'vad.speech_start') {
        if (turnCancellation.interrupt()) safeSend(client, { type: 'interrupted', turnId: currentTurn });
        safeSend(client, { type: 'speech_start' });
      } else if (type === 'vad.speech_end') safeSend(client, { type: 'speech_end' });
      else if (type === 'transcript.partial') safeSend(client, { type: 'transcript_partial', text: event.text || '', language: event.language || language });
      else if (type === 'transcript.final') {
        const text = String(event.text || '').trim();
        const now = Date.now();
        if (!text || isDuplicateFinal(lastFinal, lastFinalAt, text, now)) return;
        lastFinal = text; lastFinalAt = now;
        const detected = event.language;
        const responseLanguage = resolveVoiceLanguage(language, isSupportedLanguage(detected) ? detected : undefined);
        safeSend(client, { type: 'transcript_final', text, language: responseLanguage });
        void runVoiceTurn(client, merchantId, text, responseLanguage, history, () => ++currentTurn, () => currentTurn, (controller) => turnCancellation.attach(controller));
      } else if (type === 'error') {
        const fatal = Boolean(event.is_fatal);
        safeSend(client, { type: 'error', code: `stt_${event.code || 'error'}`, message: fatal ? 'Speech provider stopped the session. Check provider access or quota.' : 'Speech recognition had a temporary issue.' });
        if (fatal) client.close(1011, 'speech provider error');
      }
    });
    connection.on('error', () => safeSend(client, { type: 'error', code: 'stt_disconnect', message: 'Speech recognition disconnected.' }));
    connection.on('close', (event: any) => {
      if (!ended && event?.code !== 1000) safeSend(client, { type: 'error', code: `stt_close_${event?.code || 0}`, message: 'Speech recognition connection closed.' });
    });
  }).catch(() => {
    safeSend(client, { type: 'error', code: 'stt_connect_failed', message: 'Could not connect to Sarvam speech recognition.' });
    client.close(1011, 'speech provider unavailable');
  });

  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (ended) return;
    if (isBinary) {
      if (data.length > 32_768) { client.close(1009, 'audio frame too large'); return; }
      const audio = data.toString('base64');
      try {
        if (sttSocket) sttSocket.sendRealtimeAudioInput({ audio });
        else sttPromise?.then((connection: any) => { if (!ended) connection.sendRealtimeAudioInput({ audio }); }).catch(() => {});
      } catch { safeSend(client, { type: 'error', code: 'audio_send_failed', message: 'Audio could not be forwarded.' }); }
      return;
    }
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'end') { safeSend(client, { type: 'ended' }); client.close(1000, 'ended by merchant'); }
      else if (message.type === 'language' && LANGS.has(message.language)) {
        language = message.language;
        const newLanguage = language;
        if (sttSocket) sttSocket.sendRealtimeConfigUpdate({ language_code: newLanguage === 'auto' ? 'auto' : newLanguage });
        else sttPromise?.then((connection: any) => { if (!ended) connection.sendRealtimeConfigUpdate({ language_code: newLanguage === 'auto' ? 'auto' : newLanguage }); }).catch(() => {});
        safeSend(client, { type: 'language_changed', language });
      } else if (message.type === 'resume' && Array.isArray(message.history)) {
        history.splice(0, history.length, ...message.history.slice(-8).filter((item: any) => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string' && item.content.length <= 2000));
      } else if (message.type === 'text_turn' && typeof message.text === 'string' && message.text.trim().length <= 1000) {
        turnCancellation.interrupt();
        void runVoiceTurn(client, merchantId, message.text.trim(), language === 'auto' ? 'en-IN' : language, history, () => ++currentTurn, () => currentTurn, (controller) => turnCancellation.attach(controller));
      } else if (message.type === 'interrupt') {
        if (turnCancellation.interrupt()) safeSend(client, { type: 'interrupted', turnId: currentTurn });
      }
    } catch { safeSend(client, { type: 'error', code: 'invalid_message', message: 'Invalid voice session event.' }); }
  });
  client.on('close', () => { clearTimeout(expiryTimer); clearInterval(pingTimer); clearInterval(sessionRecheckTimer); close(); });
  client.on('error', () => { clearTimeout(expiryTimer); clearInterval(pingTimer); clearInterval(sessionRecheckTimer); close(); });
}

async function runVoiceTurn(
  client: ClientSocket,
  merchantId: Types.ObjectId,
  text: string,
  language: string,
  history: TurnMessage[],
  nextId: () => number,
  currentId: () => number,
  setController: (controller: AbortController) => void,
) {
  const id = nextId();
  const controller = new AbortController();
  setController(controller);
  safeSend(client, { type: 'processing', turnId: id });
  history.push({ role: 'user', content: text });

  const inferred = inferVoiceTool(text);
  if (inferred && 'clarification' in inferred) {
    safeSend(client, { type: 'assistant_text', turnId: id, text: inferred.clarification });
    history.push({ role: 'assistant', content: inferred.clarification });
    await speakSingle(inferred.clarification, language, client, controller.signal, id);
    if (currentId() === id) safeSend(client, { type: 'assistant_done', turnId: id });
    return;
  }
  if (inferred) {
    const tool = voiceToolSchema.parse(inferred);
    let output;
    try { output = await runVoiceTool(merchantId, tool); }
    catch {
      safeSend(client, { type: 'error', code: 'tool_failed', message: 'I could not retrieve that merchant data right now.' });
      return;
    }
    if (controller.signal.aborted || currentId() !== id) return;
    const spoken = summarizeTool(output.tool, output.result, language);
    safeSend(client, { type: 'tool_result', turnId: id, result: output.result, evidence: output.evidence });
    safeSend(client, { type: 'assistant_text', turnId: id, text: spoken });
    history.push({ role: 'assistant', content: spoken });
    await speakSingle(spoken, language, client, controller.signal, id);
    if (!controller.signal.aborted && currentId() === id) safeSend(client, { type: 'assistant_done', turnId: id });
    return;
  }

  const queue = new AsyncTextQueue();
  let answer = '';
  let sentenceBuffer = '';
  const tts = streamTts(queue, language, client, controller.signal, id)
    .catch((error) => { if (!controller.signal.aborted) safeSend(client, { type: 'error', code: 'tts_failed', message: 'Speech playback generation failed. You can still read the transcript.' }); throw error; });
  try {
    for await (const token of streamAssistantResponse(text, merchantId, language, history.slice(0, -1), controller.signal)) {
      if (controller.signal.aborted || currentId() !== id) break;
      answer += token;
      sentenceBuffer += token;
      safeSend(client, { type: 'assistant_delta', turnId: id, text: token });
      const split = splitSentence(sentenceBuffer);
      for (const sentence of split.ready) queue.push(sentence);
      sentenceBuffer = split.rest;
    }
  } catch {
    if (!controller.signal.aborted) safeSend(client, { type: 'error', code: 'assistant_failed', message: 'The assistant could not complete that response.' });
  } finally {
    if (!controller.signal.aborted && sentenceBuffer.trim()) queue.push(sentenceBuffer.trim());
    queue.close();
    await tts.catch(() => {});
  }
  if (answer.trim()) history.push({ role: 'assistant', content: answer.trim() });
  const boundedHistory = trimVoiceHistory(history);
  if (boundedHistory !== history) history.splice(0, history.length, ...boundedHistory);
  if (!controller.signal.aborted && currentId() === id) safeSend(client, { type: 'assistant_done', turnId: id });
}

async function speakSingle(text: string, language: string, client: ClientSocket, signal: AbortSignal, turnId: number) {
  const queue = new AsyncTextQueue(); queue.push(text); queue.close();
  try { await streamTts(queue, language, client, signal, turnId); }
  catch { safeSend(client, { type: 'error', code: 'tts_failed', message: 'Speech playback generation failed. You can still read the transcript.' }); }
}
