import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sarvamChat } from '../services/sarvam-client.js';
import { Customer } from '../db/models.js';
import { getRequestMerchantId } from '../db/helpers.js';
import { messageShareProvider } from '../services/messaging-provider.js';

const messageSchema = z.object({
  segment: z.enum(['inactive', 'loyal', 'regular', 'new', 'all']),
  campaignName: z.string().optional(),
  offerDetails: z.string().max(500).optional(),
  language: z.string().default('en-IN'),
});

const customerListSchema = z.object({
  segment: z.enum(['inactive', 'loyal', 'regular', 'new', 'all']).default('all'),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function customersRoutes(app: FastifyInstance) {

  // GET /api/customers — merchant-scoped directory and segment search.
  app.get('/', async (req, reply) => {
    const parsed = customerListSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const merchantId = await getRequestMerchantId(req);
    const { segment, q, page, pageSize } = parsed.data;
    const filter = {
      merchantId,
      ...(segment !== 'all' ? { segment } : {}),
      ...(q ? { name: { $regex: escapeRegExp(q), $options: 'i' } } : {}),
    };

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .select('name phone segment firstVisit lastVisit totalVisits totalSpent consentSms')
        .sort({ lastVisit: -1, name: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Customer.countDocuments(filter),
    ]);

    return {
      customers: customers.map((customer) => ({
        id: customer._id.toString(),
        name: customer.name,
        phoneLast4: customer.phone?.replace(/\D/g, '').slice(-4) || '',
        segment: customer.segment,
        firstVisit: customer.firstVisit,
        lastVisit: customer.lastVisit,
        totalVisits: customer.totalVisits,
        totalSpent: customer.totalSpent,
        consentSms: customer.consentSms,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  });

  // POST /api/customers/message — generate an offer message for a segment
  app.post<{ Body: unknown }>('/message', async (req, reply) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const { segment, campaignName, offerDetails, language } = parsed.data;

    const merchantId = await getRequestMerchantId(req);
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

    const whatsappUrl = messageShareProvider.createShareUrl(messageText);

    return {
      message: messageText,
      segment,
      customerCount: count,
      whatsappUrl,
      deliveryMode: 'merchant_share_handoff',
      provider: messageShareProvider.name,
      language,
    };
  });

  // GET /api/customers/segments — count per segment
  app.get('/segments', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const customers = await Customer.find({ merchantId }).lean();
    const segments: Record<string, number> = {};
    customers.forEach((c) => {
      segments[c.segment] = (segments[c.segment] || 0) + 1;
    });
    return { segments, total: customers.length };
  });
}
