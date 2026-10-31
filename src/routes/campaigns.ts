import { FastifyInstance } from 'fastify';
import { Campaign, CampaignResult, CampaignTarget, AiRecommendation } from '../db/models.js';
import { simulateCampaign } from '../services/campaign-simulator.js';

export async function campaignRoutes(app: FastifyInstance) {
  // GET /api/campaigns — list all campaigns
  app.get('/', async () => {
    const campaigns = await Campaign.find()
      .sort({ createdAt: -1 })
      .lean();

    // Populate results and recommendations
    const enriched = await Promise.all(
      campaigns.map(async (c) => {
        const results = await CampaignResult.find({ campaignId: c._id }).lean();
        const recommendation = c.recommendationId
          ? await AiRecommendation.findById(c.recommendationId).lean()
          : null;
        return { ...c, results, recommendation };
      })
    );

    return { campaigns: enriched };
  });

  // GET /api/campaigns/:id
  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) throw new Error('Campaign not found');

    const [results, recommendation, targets] = await Promise.all([
      CampaignResult.find({ campaignId: campaign._id }).lean(),
      campaign.recommendationId ? AiRecommendation.findById(campaign.recommendationId).lean() : null,
      CampaignTarget.find({ campaignId: campaign._id }).lean(),
    ]);

    return { campaign: { ...campaign, results, recommendation, targets } };
  });

  // PATCH /api/campaigns/:id/approve
  app.patch<{ Params: { id: string } }>('/:id/approve', async (req) => {
    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', approvedAt: new Date() },
      { new: true }
    ).lean();
    return { campaign, message: 'Campaign approved successfully' };
  });

  // PATCH /api/campaigns/:id/reject
  app.patch<{ Params: { id: string } }>('/:id/reject', async (req) => {
    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected' },
      { new: true }
    ).lean();
    return { campaign, message: 'Campaign rejected' };
  });

  // PUT /api/campaigns/:id — edit campaign
  app.put<{ Params: { id: string }; Body: Record<string, any> }>('/:id', async (req) => {
    const { name, description, budgetAmount, discountPercent, targetSegment, timeSlotStart, timeSlotEnd, daysOfWeek } = req.body;
    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      {
        ...(name && { name }),
        ...(description && { description }),
        ...(budgetAmount && { budgetAmount }),
        ...(discountPercent !== undefined && { discountPercent }),
        ...(targetSegment && { targetSegment }),
        ...(timeSlotStart !== undefined && { timeSlotStart }),
        ...(timeSlotEnd !== undefined && { timeSlotEnd }),
        ...(daysOfWeek && { daysOfWeek }),
      },
      { new: true }
    ).lean();
    return { campaign };
  });

  // POST /api/campaigns/:id/simulate
  app.post<{ Params: { id: string } }>('/:id/simulate', async (req) => {
    const result = await simulateCampaign(req.params.id);
    return result;
  });

  // GET /api/campaigns/:id/results — get campaign ROI details
  app.get<{ Params: { id: string } }>('/:id/results', async (req) => {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) throw new Error('Campaign not found');

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