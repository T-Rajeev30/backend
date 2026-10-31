import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sarvamChat } from '../services/sarvam-client.js';
import { Customer } from '../db/models.js';
import { getMerchantId } from '../db/helpers.js';

const messageSchema = z.object({
  segment: z.enum(['inactive', 'loyal', 'regular', 'new', 'all']),
  campaignName: z.string().optional(),
  offerDetails: z.string().optional(),
  language: z.string().default('en-IN'),
});

export async function customersRoutes(app: FastifyInstance) {

  // POST /api/customers/message — generate an offer message for a segment
  app.post<{ Body: unknown }>('/message', async (req, reply) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { segment, campaignName, offerDetails, language } = parsed.data;

    const merchantId = await getMerchantId();
    const count = await Customer.countDocuments({
      merchantId,
      ...(segment !== 'all' ? { segment } : {}),
    });

    let messageText: string;
    try {
      messageText = await sarvamChat([
        {
          role: 'system',
          content: `You write short, friendly marketing messages for a Paytm merchant's customers. The message will be shared on WhatsApp. Keep it under 160 characters. Include the offer details if provided. Write in ${language === 'en-IN' ? 'English' : 'the language ' + language}. HARD RULE: never invent discount percentages or prices — only use what is given.`,
        },
        {
          role: 'user',
          content: `Write a short WhatsApp offer message for ${count} ${segment} customers.${campaignName ? ` Campaign: ${campaignName}.` : ''}${offerDetails ? ` Offer: ${offerDetails}.` : ' General loyalty/reactivation message.'}`,
        },
      ]);
    } catch {
      messageText = segment === 'inactive'
        ? `We miss you! Visit us again and enjoy a special offer. 🎉`
        : `Thank you for being a valued customer! Here's something special for you. ⭐`;
    }

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(messageText)}`;

    return {
      message: messageText,
      segment,
      customerCount: count,
      whatsappUrl,
      language,
    };
  });

  // GET /api/customers/segments — count per segment
  app.get('/segments', async () => {
    const merchantId = await getMerchantId();
    const customers = await Customer.find({ merchantId }).lean();
    const segments: Record<string, number> = {};
    customers.forEach((c) => {
      segments[c.segment] = (segments[c.segment] || 0) + 1;
    });
    return { segments, total: customers.length };
  });
}
