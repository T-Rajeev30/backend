import { FastifyInstance } from 'fastify';
import { Campaign, CampaignResult, CampaignTarget, AiRecommendation } from '../db/models.js';
import { simulateCampaign } from '../services/campaign-simulator.js';
import { getRequestMerchantId } from '../db/helpers.js';
import { z } from 'zod';

function validateCampaignId(id: string) {
  if (!/^[a-f\d]{24}$/i.test(id)) {
    throw Object.assign(new Error('Invalid campaign ID'), { statusCode: 400 });
  }
}

function campaignNotFound() {
  return Object.assign(new Error('Campaign not found'), { statusCode: 404 });
}

const createCampaignSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).default(''),
  type: z.enum(['discount', 'combo', 'loyalty', 'reactivation']).default('discount'),
  channel: z.enum(['message', 'voice']).default('message'),
  voiceMessage: z.string().trim().max(5000).optional(),
  voiceLanguage: z.enum(['en-IN', 'hi-IN', 'kn-IN']).default('en-IN'),
  targetSegment: z.enum(['inactive', 'regular', 'loyal', 'new', 'all']).default('all'),
  budgetAmount: z.coerce.number().finite().min(0).max(10_000_000),
  discountPercent: z.coerce.number().finite().min(0).max(50).default(0),
  durationDays: z.coerce.number().int().min(1).max(60).default(14),
  daysOfWeek: z.string().regex(/^[1-7](,[1-7])*$/).default('1,2,3,4,5'),
  timeSlotStart: z.coerce.number().int().min(0).max(23).default(14),
  timeSlotEnd: z.coerce.number().int().min(1).max(24).default(17),
}).refine((value) => value.timeSlotEnd > value.timeSlotStart, {
  message: 'End time must be after start time',
  path: ['timeSlotEnd'],
}).refine((value) => value.channel !== 'voice' || Boolean(value.voiceMessage), {
  message: 'A voice message is required for a voice campaign',
  path: ['voiceMessage'],
});

const updateCampaignSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  budgetAmount: z.coerce.number().finite().min(0).max(10_000_000).optional(),
  discountPercent: z.coerce.number().finite().min(0).max(50).optional(),
  targetSegment: z.enum(['inactive', 'regular', 'loyal', 'new', 'all']).optional(),
  channel: z.enum(['message', 'voice']).optional(),
  voiceMessage: z.string().trim().max(5000).optional(),
  voiceLanguage: z.enum(['en-IN', 'hi-IN', 'kn-IN']).optional(),
  timeSlotStart: z.coerce.number().int().min(0).max(23).optional(),
  timeSlotEnd: z.coerce.number().int().min(1).max(24).optional(),
  daysOfWeek: z.string().regex(/^[1-7](,[1-7])*$/).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'At least one campaign field must be provided',
}).refine((value) => value.timeSlotStart === undefined || value.timeSlotEnd === undefined || value.timeSlotEnd > value.timeSlotStart, {
  message: 'End time must be after start time',
  path: ['timeSlotEnd'],
});

export async function campaignRoutes(app: FastifyInstance) {
  // Create a draft campaign for the selected merchant.
  app.post<{ Body: unknown }>('/', async (req, reply) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues });
    }
    const merchantId = await getRequestMerchantId(req);
    const values = parsed.data;
    const startDate = new Date();
    const campaign = await Campaign.create({
      merchantId,
      name: values.name,
      description: values.description,
      type: values.type,
      status: 'pending',
      targetSegment: values.targetSegment,
      channel: values.channel,
      voiceMessage: values.voiceMessage,
      voiceLanguage: values.voiceLanguage,
      startDate,
      endDate: new Date(startDate.getTime() + values.durationDays * 86400000),
      timeSlotStart: values.timeSlotStart,
      timeSlotEnd: values.timeSlotEnd,
      daysOfWeek: values.daysOfWeek,
      budgetAmount: values.budgetAmount,
      discountPercent: values.discountPercent,
    });
    return reply.status(201).send({ campaign, message: 'Campaign draft created for approval' });
  });

  // GET /api/campaigns — list all campaigns
  app.get('/', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const campaigns = await Campaign.find({ merchantId })
      .sort({ createdAt: -1 })
      .lean();

    // Populate results and recommendations
    const enriched = await Promise.all(
      campaigns.map(async (c) => {
        const results = await CampaignResult.find({ campaignId: c._id }).lean();
        const recommendation = c.recommendationId
          ? await AiRecommendation.findOne({ _id: c.recommendationId, merchantId }).lean()
          : null;
        return { ...c, results, recommendation };
      })
    );

    return { campaigns: enriched };
  });

  // GET /api/campaigns/:id
  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req);
    const campaign = await Campaign.findOne({ _id: req.params.id, merchantId }).lean();
    if (!campaign) throw campaignNotFound();

    const [results, recommendation, targets] = await Promise.all([
      CampaignResult.find({ campaignId: campaign._id }).lean(),
      campaign.recommendationId ? AiRecommendation.findOne({ _id: campaign.recommendationId, merchantId }).lean() : null,
      CampaignTarget.find({ campaignId: campaign._id }).lean(),
    ]);

    return { campaign: { ...campaign, results, recommendation, targets } };
  });

  // PATCH /api/campaigns/:id/approve
  app.patch<{ Params: { id: string } }>('/:id/approve', async (req) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, merchantId, status: 'pending' },
      { status: 'approved', approvedAt: new Date() },
      { new: true }
    ).lean();
    if (!campaign) throw Object.assign(new Error('Campaign is not available for approval'), { statusCode: 409 });
    return { campaign, message: 'Campaign approved successfully' };
  });

  // PATCH /api/campaigns/:id/reject
  app.patch<{ Params: { id: string } }>('/:id/reject', async (req) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, merchantId, status: 'pending' },
      { status: 'rejected' },
      { new: true }
    ).lean();
    if (!campaign) throw Object.assign(new Error('Campaign is not available for rejection'), { statusCode: 409 });
    return { campaign, message: 'Campaign rejected' };
  });

  // PUT /api/campaigns/:id — edit campaign
  app.put<{ Params: { id: string }; Body: unknown }>('/:id', async (req, reply) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req);
    const parsed = updateCampaignSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const { name, description, budgetAmount, discountPercent, targetSegment, channel, voiceMessage, voiceLanguage, timeSlotStart, timeSlotEnd, daysOfWeek } = parsed.data;
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, merchantId, status: 'pending' },
      {
        ...(name && { name }),
        ...(description && { description }),
        ...(budgetAmount !== undefined && { budgetAmount }),
        ...(discountPercent !== undefined && { discountPercent }),
        ...(targetSegment && { targetSegment }),
        ...(channel && { channel }),
        ...(voiceMessage !== undefined && { voiceMessage }),
        ...(voiceLanguage && { voiceLanguage }),
        ...(timeSlotStart !== undefined && { timeSlotStart }),
        ...(timeSlotEnd !== undefined && { timeSlotEnd }),
        ...(daysOfWeek && { daysOfWeek }),
      },
      { new: true }
    ).lean();
    if (!campaign) throw Object.assign(new Error('Only pending campaigns can be edited'), { statusCode: 409 });
    return { campaign };
  });

  // POST /api/campaigns/:id/simulate
  app.post<{ Params: { id: string } }>('/:id/simulate', async (req) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);
    const result = await simulateCampaign(req.params.id, merchantId);
    return result;
  });

  // GET /api/campaigns/:id/results — get campaign ROI details
  app.get<{ Params: { id: string } }>('/:id/results', async (req) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req);
    const campaign = await Campaign.findOne({ _id: req.params.id, merchantId }).lean();
    if (!campaign) throw campaignNotFound();

    const [results, targets] = await Promise.all([
      CampaignResult.find({ campaignId: campaign._id }).lean(),
      CampaignTarget.find({ campaignId: campaign._id }).lean(),
    ]);

    if (results.length === 0) return { message: 'Campaign has not been simulated yet' };

    const result = results[0];
    const treatmentTargets = targets.filter((t) => t.groupType === 'treatment');
    const controlTargets = targets.filter((t) => t.groupType === 'control');

    return {
      campaign: {
        id: campaign._id,
        name: campaign.name,
        status: campaign.status,
        type: campaign.type,
      },
      funnel: {
        totalTargeted: result.totalTargeted,
        treatmentGroup: treatmentTargets.length,
        controlGroup: controlTargets.length,
        contacted: result.totalContacted,
        responded: result.totalResponded,
        purchased: result.totalPurchased,
      },
      financials: {
        totalCampaignCost: result.totalCampaignCost,
        treatmentRevenue: result.treatmentRevenue,
        controlRevenue: result.controlRevenue,
        incrementalRevenue: result.incrementalRevenue,
        incrementalProfit: result.incrementalProfit,
        merchantRoi: result.merchantRoi,
      },
      conversionRates: {
        treatmentRate: treatmentTargets.length > 0
          ? parseFloat(((treatmentTargets.filter((t) => t.purchased).length / treatmentTargets.length) * 100).toFixed(1))
          : 0,
        controlRate: controlTargets.length > 0
          ? parseFloat(((controlTargets.filter((t) => t.purchased).length / controlTargets.length) * 100).toFixed(1))
          : 0,
        lift: 0,
      },
    };
  });
}
