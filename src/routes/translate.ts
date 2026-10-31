import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from '../services/sarvam-client.js';
import { translateText, translateMany } from '../services/translation-service.js';

const translateBodySchema = z.object({
  text: z.string().min(1).max(5000),
  target: z.string(),
  source: z.string().optional(),
});

const batchBodySchema = z.object({
  texts: z.array(z.string().min(1)).min(1).max(50),
  target: z.string(),
});

export async function translateRoutes(app: FastifyInstance) {
  app.get('/languages', async () => {
    return Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => ({ code, name }));
  });

  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const parsed = translateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { text, target, source } = parsed.data;
    if (!isSupportedLanguage(target)) {
      return reply.status(400).send({ error: `Unsupported target language: ${target}` });
    }
    const translatedText = await translateText(text, target, source || 'auto');
    return { translatedText, target };
  });

  app.post<{ Body: unknown }>('/batch', async (req, reply) => {
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { texts, target } = parsed.data;
    if (!isSupportedLanguage(target)) {
      return reply.status(400).send({ error: `Unsupported target language: ${target}` });
    }
    const translations = await translateMany(texts, target);
    return { translations };
  });
}
