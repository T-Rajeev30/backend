import { FastifyInstance } from 'fastify';
import { AiRecommendation, Campaign } from '../db/models.js';
import { getRequestMerchantId } from '../db/helpers.js';
import { runOpportunityDetection } from '../services/opportunity-engine.js';
import { generateRecommendation } from '../services/ai-service.js';

export async function opportunityRoutes(app: FastifyInstance) {

  // POST /api/opportunities/detect — detect/update actionable opportunities.
  app.post('/detect', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const opportunities = await runOpportunityDetection(merchantId);

    const saved = await Promise.all(opportunities.map((opp) =>
      AiRecommendation.findOneAndUpdate(
        { merchantId, opportunityType: opp.type, title: opp.title, status: 'new' },
        { $set: {
          description: opp.description,
          reasoning: opp.reasoning,
          severity: opp.severity,
          metrics: opp.metrics,
          suggestedAction: opp.suggestedAction,
          estimatedCost: opp.estimatedCost,
          estimatedProfit: opp.estimatedProfit,
        } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ),
    ));

    return { opportunities: saved };
  });

  // GET /api/opportunities — list all detected opportunities
  app.get('/', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const recommendations = await AiRecommendation.find({ merchantId })
      .sort({ createdAt: -1 })
      .lean();
    return { recommendations };
  });

  // POST /api/opportunities/:id/recommend — generate AI campaign recommendation
  app.post<{ Params: { id: string } }>('/:id/recommend', async (req) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      throw Object.assign(new Error('Invalid opportunity ID'), { statusCode: 400 });
    }
    const merchantId = await getRequestMerchantId(req);
    const rec = await AiRecommendation.findOne({ _id: req.params.id, merchantId }).lean();
    if (!rec) throw Object.assign(new Error('Recommendation not found'), { statusCode: 404 });

    const suggestion = await generateRecommendation({
      type: rec.opportunityType,
      title: rec.title,
      description: rec.description,
      metrics: rec.metrics,
      merchantId,
    });

    const campaign = await Campaign.create({
      merchantId: rec.merchantId,
      recommendationId: rec._id,
      name: suggestion.campaignName,
      description: suggestion.description,
      type: suggestion.type,
      status: 'pending',
      targetSegment: suggestion.targetSegment,
      channel: 'message',
      startDate: new Date(),
      endDate: new Date(Date.now() + (suggestion.durationDays || 14) * 86400000),
      timeSlotStart: suggestion.timeSlotStart,
      timeSlotEnd: suggestion.timeSlotEnd,
      daysOfWeek: suggestion.daysOfWeek,
      budgetAmount: rec.estimatedCost,
      discountPercent: suggestion.discountPercent,
      estimatedProfit: rec.estimatedProfit,
    });

    await AiRecommendation.findOneAndUpdate({ _id: rec._id, merchantId }, { status: 'actioned' });

    return {
      campaign,
      reasoning: suggestion.reasoning,
    };
  });
}
