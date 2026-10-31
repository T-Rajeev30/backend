import { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { getSarvam } from '../sarvam-client.js';
import { Campaign, DemoCall, Merchant } from '../../db/models.js';
import { buildOpeningLine, buildSystemPrompt, type DemoCallLanguage } from '../demo-call/demo-call-script.js';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws') as {
  WebSocketServer: new (options: Record<string, unknown>) => any;
  WebSocket: { OPEN: number };
};

/**
 * Exotel "Connect Voice AI" bidirectional media bridge.
 * Docs: https://developer.exotel.com/docs/agentstream/connect-voice-ai
 *
 * Exotel opens this WebSocket when the call is answered and streams base64
 * PCM16 audio. We run Sarvam realtime STT -> LLM (demo-call script) ->
 * streaming TTS and stream audio back. Barge-in uses Exotel's "clear" event.
 *
 * This path requires a publicly reachable wss endpoint and a real answered
 * call, so it cannot run against localhost or in automated tests.
 */

function send(socket: any, value: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function splitSentences(buffer: string): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let last = 0;
  for (const match of buffer.matchAll(/[.!?।]\s+/gu)) {
    const end = (match.index || 0) + match[0].length;
    if (end - last >= 20) { ready.push(buffer.slice(last, end).trim()); last = end; }
  }
  return { ready, rest: buffer.slice(last) };
}

export function registerExotelMediaWebSocket(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/telephony/exotel/media') return; // other upgrades handled elsewhere
    void (async () => {
      const token = url.searchParams.get('token') || '';
      if (!token) throw new Error('missing token');
      const demoCall = await DemoCall.findOne({ correlationId: token });
      if (!demoCall) throw new Error('unknown call token');
      wss.handleUpgrade(request, socket, head, (client: any) => handleExotelCall(client, demoCall._id.toString()));
    })().catch(() => { try { socket.destroy(); } catch {} });
  });
}

async function handleExotelCall(client: any, demoCallId: string) {
  const sarvam = getSarvam();
  const demoCall = await DemoCall.findById(demoCallId);
  if (!demoCall) { try { client.close(); } catch {} return; }
  if (!sarvam) {
    demoCall.lastError = 'Sarvam is not configured; cannot run the call conversation.';
    demoCall.status = 'failed';
    await demoCall.save();
    try { client.close(); } catch {}
    return;
  }

  const [campaign, merchant] = await Promise.all([
    Campaign.findById(demoCall.campaignId).lean(),
    Merchant.findById(demoCall.merchantId).lean(),
  ]);
  const language = demoCall.language as DemoCallLanguage;
  const discountPercent = campaign?.discountPercent || 10;
  const merchantName = merchant?.name || "the merchant";
  const scriptInput = { recipientName: demoCall.recipientName, merchantName, discountPercent, language };
  const systemPrompt = buildSystemPrompt(scriptInput);
  const openingLine = buildOpeningLine(scriptInput);

  let streamSid = '';
  let ended = false;
  let stt: any = null;
  let currentTurn = 0;
  let activeController: AbortController | null = null;
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  const appendTranscript = (role: 'assistant' | 'customer', text: string) => {
    if (!text.trim()) return;
    demoCall.transcript.push({ role, text: text.trim(), at: new Date() } as any);
    void demoCall.save().catch(() => {});
  };

  const bargeIn = () => {
    if (activeController) { activeController.abort(); activeController = null; }
    send(client, { event: 'clear', stream_sid: streamSid });
  };

  const close = async (outcome?: string) => {
    if (ended) return;
    ended = true;
    if (activeController) activeController.abort();
    try { stt?.sendRealtimeEnd?.({}); stt?.close?.(); } catch {}
    if (outcome && !demoCall.outcome) { demoCall.outcome = outcome; }
    await demoCall.save().catch(() => {});
    try { client.close(); } catch {}
  };

  // Stream one assistant turn to the caller: LLM tokens -> sentence TTS -> media.
  const speak = async (userText: string | null) => {
    const id = ++currentTurn;
    const controller = new AbortController();
    activeController = controller;
    if (userText) history.push({ role: 'user', content: userText });

    const ttsSocket = await sarvam.textToSpeechStreaming.connect({
      model: (process.env.SARVAM_TTS_MODEL || 'bulbul:v3') as any,
      send_completion_event: 'true',
      reconnectAttempts: 0,
    });
    ttsSocket.on('message', (message: any) => {
      if (controller.signal.aborted || id !== currentTurn) return;
      if (message?.type === 'audio' && typeof message.data?.audio === 'string') {
        send(client, { event: 'media', stream_sid: streamSid, media: { payload: message.data.audio } });
      }
    });
    ttsSocket.connect();
    await ttsSocket.waitForOpen();
    ttsSocket.configureConnection({
      language_code: language as any,
      speaker: (process.env.SARVAM_TTS_SPEAKER || 'shubh') as any,
      output_audio_codec: 'linear16',
      speech_sample_rate: Number(process.env.EXOTEL_STREAM_SAMPLE_RATE || '16000'),
      min_buffer_size: 40,
      max_chunk_length: 180,
    });

    let answer = '';
    const pushSentence = (sentence: string) => { if (sentence.trim()) ttsSocket.convert(sentence.trim()); };

    if (userText === null) {
      // Opening line — spoken verbatim, not generated.
      answer = openingLine;
      pushSentence(openingLine);
      appendTranscript('assistant', openingLine);
      history.push({ role: 'assistant', content: openingLine });
    } else {
      let buffer = '';
      try {
        const stream = await sarvam.chat.completions({
          model: (process.env.SARVAM_CHAT_MODEL || 'sarvam-105b-conversations') as any,
          messages: [{ role: 'system', content: systemPrompt }, ...history.slice(-8)],
          temperature: 0.3,
          max_tokens: 200,
          stream: true,
        }, { abortSignal: controller.signal, maxRetries: 0 });
        for await (const chunk of stream) {
          if (controller.signal.aborted || id !== currentTurn) break;
          const token = chunk.choices?.[0]?.delta?.content;
          if (typeof token === 'string' && token) {
            const clean = token.replace(/<think>[\s\S]*?<\/think>/g, '');
            answer += clean; buffer += clean;
            const split = splitSentences(buffer);
            for (const sentence of split.ready) pushSentence(sentence);
            buffer = split.rest;
          }
        }
        if (!controller.signal.aborted && buffer.trim()) pushSentence(buffer);
      } catch { /* LLM failure — end turn gracefully */ }
      if (answer.trim()) { appendTranscript('assistant', answer); history.push({ role: 'assistant', content: answer.trim() }); }
    }
    try { ttsSocket.flush?.(); } catch {}
    // Let TTS drain briefly, then close this turn's socket.
    setTimeout(() => { try { ttsSocket.close(); } catch {} }, 8000);
  };

  // Connect Sarvam realtime STT for the inbound caller audio.
  try {
    stt = await sarvam.speechToTextRealtimeStreaming.connect({
      'Api-Subscription-Key': process.env.SARVAM_API_KEY || '',
      language_code: language as any,
      model: 'saaras:v3-realtime', stream_type: 'fast', endpointing: 'vad', encoding: 'linear16',
      sample_rate: String(process.env.EXOTEL_STREAM_SAMPLE_RATE || '16000'),
      silence_duration_ms: '700', min_speech_duration_ms: '250', reconnectAttempts: 0,
    });
    stt.on('message', (event: any) => {
      if (ended || !event) return;
      if (event.event === 'vad.speech_start') bargeIn();
      else if (event.event === 'transcript.final') {
        const text = String(event.text || '').trim();
        if (!text) return;
        appendTranscript('customer', text);
        void speak(text);
      }
    });
    stt.on('error', () => {});
  } catch {
    demoCall.lastError = 'Could not connect to speech recognition.';
    await demoCall.save().catch(() => {});
  }

  client.on('message', (raw: Buffer) => {
    if (ended) return;
    let message: any;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    switch (message.event) {
      case 'connected':
        break;
      case 'start':
        streamSid = message.start?.stream_sid || message.stream_sid || '';
        if (demoCall.status !== 'in-progress') { demoCall.status = 'in-progress'; demoCall.answeredAt = new Date(); void demoCall.save().catch(() => {}); }
        void speak(null); // opening line
        break;
      case 'media':
        if (message.media?.payload) { try { stt?.sendRealtimeAudioInput?.({ audio: message.media.payload }); } catch {} }
        break;
      case 'stop':
        void close('completed');
        break;
      default:
        break;
    }
  });
  client.on('close', () => { void close(); });
  client.on('error', () => { void close(); });
}
