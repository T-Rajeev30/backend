import { FastifyInstance } from 'fastify';
import { AiRecommendation, Campaign } from '../db/models.js';
import { getMerchantId } from '../db/helpers.js';
import { runOpportunityDetection } from '../services/opportunity-engine.js';
import { generateRecommendation } from '../services/ai-service.js';

export async function opportunityRoutes(app: FastifyInstance) {

  // GET /api/opportunities/detect — run opportunity detection engine
  app.get('/detect', async () => {
    const merchantId = await getMerchantId();
    const opportunities = await runOpportunityDetection();

    const saved = await Promise.all(
      opportunities.map((opp) =>
        AiRecommendation.create({
          merchantId,
          opportunityType: opp.type,
          title: opp.title,
          description: opp.description,
          reasoning: opp.reasoning,
          severity: opp.severity,
          metrics: opp.metrics,
          suggestedAction: opp.suggestedAction,
          estimatedCost: opp.estimatedCost,
          estimatedProfit: opp.estimatedProfit,
        })
      )
    );

    return { opportunities: saved };
  });

  // GET /api/opportunities — list all detected opportunities
  app.get('/', async () => {
    const merchantId = await getMerchantId();
    const recommendations = await AiRecommendation.find({ merchantId })
      .sort({ createdAt: -1 })
      .lean();
    return { recommendations };
  });

  // POST /api/opportunities/:id/recommend — generate AI campaign recommendation
  app.post<{ Params: { id: string } }>('/:id/recommend', async (req) => {
    const rec = await AiRecommendation.findById(req.params.id).lean();
    if (!rec) throw new Error('Recommendation not found');

    const suggestion = await generateRecommendation({
      type: rec.opportunityType,
      title: rec.title,
      description: rec.description,
      metrics: rec.metrics,
    });

    const campaign = await Campaign.create({
      merchantId: rec.merchantId,
      recommendationId: rec._id,
      name: suggestion.campaignName,
      description: suggestion.description,
      type: suggestion.type,
      status: 'pending',
      targetSegment: suggestion.targetSegment,
      startDate: new Date(),
      endDate: new Date(Date.now() + (suggestion.durationDays || 14) * 86400000),
      timeSlotStart: suggestion.timeSlotStart,
      timeSlotEnd: suggestion.timeSlotEnd,
      daysOfWeek: suggestion.daysOfWeek,
      budgetAmount: rec.estimatedCost,
      discountPercent: suggestion.discountPercent,
      estimatedProfit: rec.estimatedProfit,
    });

    await AiRecommendation.findByIdAndUpdate(rec._id, { status: 'actioned' });

    return {
      campaign,
      reasoning: suggestion.reasoning,
    };
  });
}