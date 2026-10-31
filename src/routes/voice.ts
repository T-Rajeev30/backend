import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSupportedLanguage } from '../services/sarvam-client.js';
import { transcribe, speak } from '../services/voice-service.js';
import { chatWithAssistant } from '../services/ai-service.js';
import { getRequestMerchantId } from '../db/helpers.js';
import { runVoiceTool, voiceToolSchema } from '../services/voice-tools.js';

const transcribeSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
  language: z.string().optional(),
});

const speakSchema = z.object({
  text: z.string().min(1).max(5000),
  language: z.string(),
});

const askSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
  language: z.string().optional(),
});

const TEN_MB = 10 * 1024 * 1024;

export async function voiceRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/tools', async (req, reply) => {
    const parsed = voiceToolSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const merchantId = await getRequestMerchantId(req);
    return runVoiceTool(merchantId, parsed.data);
  });

  app.post<{ Body: unknown }>('/transcribe', {
    config: {},
    bodyLimit: 15 * 1024 * 1024,
  }, async (req, reply) => {
    const parsed = transcribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { audioBase64, mimeType, language } = parsed.data;
    const buf = Buffer.from(audioBase64, 'base64');
    if (buf.length > TEN_MB) {
      return reply.status(400).send({ error: 'Audio exceeds 10 MB limit' });
    }
    const result = await transcribe(buf, mimeType, language);
    return result;
  });

  app.post<{ Body: unknown }>('/speak', async (req, reply) => {
    const parsed = speakSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { text, language } = parsed.data;
    if (!isSupportedLanguage(language)) {
      return reply.status(400).send({ error: `Unsupported language: ${language}` });
    }
    const result = await speak(text, language);
    return result;
  });

  app.post<{ Body: unknown }>('/ask', {
    config: {},
    bodyLimit: 15 * 1024 * 1024,
  }, async (req, reply) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { audioBase64, mimeType, language } = parsed.data;
    const buf = Buffer.from(audioBase64, 'base64');
    if (buf.length > TEN_MB) {
      return reply.status(400).send({ error: 'Audio exceeds 10 MB limit' });
    }

    const sttResult = await transcribe(buf, mimeType, language);
    const detectedLang = isSupportedLanguage(sttResult.languageCode)
      ? sttResult.languageCode
      : 'en-IN';

    const merchantId = await getRequestMerchantId(req);
    const chatResult = await chatWithAssistant(sttResult.transcript, merchantId, detectedLang);

    const ttsResult = await speak(chatResult.response, detectedLang);

    return {
      transcript: sttResult.transcript,
      languageCode: sttResult.languageCode,
      response: chatResult.response,
      dataUsed: chatResult.dataUsed,
      audioBase64: ttsResult.audioBase64,
      mimeType: ttsResult.mimeType,
    };
  });
}
