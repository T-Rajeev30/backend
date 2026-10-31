import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chatWithAssistant } from '../services/ai-service.js';
import { translateObject } from '../services/translation-service.js';
import { isSupportedLanguage } from '../services/sarvam-client.js';
import { getRequestMerchantId } from '../db/helpers.js';

const chatSchema = z.object({
  message: z.string().min(1),
  language: z.string().optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});

const translateRecommendationSchema = z.object({
  recommendation: z.record(z.any()),
  language: z.string(),
});

export async function aiAssistantRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/chat', async (req, reply) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { message, language, history } = parsed.data;
    const merchantId = await getRequestMerchantId(req);
    const result = await chatWithAssistant(message, merchantId, language || 'en-IN', history || []);
    return result;
  });

  app.post<{ Body: unknown }>('/recommendation/translate', async (req, reply) => {
    const parsed = translateRecommendationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { recommendation, language } = parsed.data;
    if (!isSupportedLanguage(language)) {
      return reply.status(400).send({ error: `Unsupported language: ${language}` });
    }
    const translated = await translateObject(
      recommendation,
      language,
      ['campaignName', 'description', 'reasoning'],
    );
    return { recommendation: translated, language };
  });
}
