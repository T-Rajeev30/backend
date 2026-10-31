import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Merchant, MerchantMembership } from '../db/models.js';
import { authenticateRequest, getRequestMerchantId } from '../db/helpers.js';

const profileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  businessType: z.string().trim().min(2).max(80).optional(),
  address: z.string().trim().max(250).optional(),
  city: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'At least one profile field must be provided',
});

export async function merchantRoutes(app: FastifyInstance) {
  // The selector list is required before a merchant has been selected. In a
  // production deployment this must be limited by an authenticated identity.
  app.get('/', async (req) => {
    const { user } = await authenticateRequest(req);
    const memberships = await MerchantMembership.find({ userId: user._id }).select('merchantId').lean();
    const merchants = await Merchant.find({ _id: { $in: memberships.map((item) => item.merchantId) } }).sort({ createdAt: 1 }).lean();
    return {
      merchants: merchants.map((merchant) => ({
        id: merchant._id.toString(),
        name: merchant.name,
        businessType: merchant.businessType,
        city: merchant.city,
        dataMode: merchant.dataMode || 'simulated',
      })),
    };
  });

  app.get('/active', async (req, reply) => {
    const merchantId = await getRequestMerchantId(req);
    const merchant = await Merchant.findById(merchantId).lean();
    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' });
    return { merchant: {
      id: merchant._id.toString(),
      name: merchant.name,
      businessType: merchant.businessType,
      city: merchant.city,
      address: merchant.address || '',
      dataMode: merchant.dataMode || 'simulated',
    } };
  });

  app.get('/profile', async (req, reply) => {
    const merchantId = await getRequestMerchantId(req);
    const merchant = await Merchant.findById(merchantId).select('name businessType address city phone email dataMode').lean();
    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' });
    return { merchant: { ...merchant, id: merchant._id.toString(), dataMode: merchant.dataMode || 'simulated' } };
  });

  app.patch<{ Body: unknown }>('/profile', async (req, reply) => {
    const parsed = profileUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);
    const merchant = await Merchant.findOneAndUpdate(
      { _id: merchantId },
      { $set: parsed.data },
      { new: true, runValidators: true },
    ).select('name businessType address city phone email dataMode').lean();
    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' });
    return { merchant: { ...merchant, id: merchant._id.toString(), dataMode: merchant.dataMode || 'simulated' } };
  });
}
