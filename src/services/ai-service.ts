import { z } from 'zod';
import { Merchant, Transaction, Customer, Product, Campaign, CampaignResult } from '../db/models.js';
import { getMerchantId } from '../db/helpers.js';
import { getSarvam, sarvamChat } from './sarvam-client.js';

async function getMerchantContext() {
  const merchant = await Merchant.findOne({ name: 'Café Brew' }).lean();
  if (!merchant) return 'No merchant data available.';

  const merchantId = merchant._id;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

  const [txns, customers, products, campaigns] = await Promise.all([
    Transaction.find({ merchantId, timestamp: { $gte: thirtyDaysAgo } }).lean(),
    Customer.find({ merchantId }).lean(),
    Product.find({ merchantId }).lean(),
    Campaign.find({ merchantId }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);

  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  const totalRevenue = txns.reduce((s, t) => s + t.amount, 0);
  const avgOrderValue = txns.length > 0 ? totalRevenue / txns.length : 0;
  const segmentCounts = { loyal: 0, regular: 0, inactive: 0, new: 0 };
  customers.forEach((c) => { segmentCounts[c.segment as keyof typeof segmentCounts] += 1; });

  const productRevenue = new Map<string, number>();
  txns.forEach((t) => {
    const p = productMap.get(t.productId.toString());
    if (p) productRevenue.set(p.name, (productRevenue.get(p.name) || 0) + t.amount);
  });

  const hourlyTxns = new Map<number, number>();
  txns.forEach((t) => { hourlyTxns.set(t.hourOfDay, (hourlyTxns.get(t.hourOfDay) || 0) + 1); });

  const campaignResults = await CampaignResult.find({
    campaignId: { $in: campaigns.map((c) => c._id) },
  }).lean();
  const resultMap = new Map(campaignResults.map((r) => [r.campaignId.toString(), r]));

  return `
MERCHANT: ${merchant.name} (${merchant.businessType}) — ${merchant.address}, ${merchant.city}

LAST 30 DAYS PERFORMANCE:
- Total Revenue: ₹${Math.round(totalRevenue).toLocaleString('en-IN')}
- Total Transactions: ${txns.length}
- Average Order Value: ₹${Math.round(avgOrderValue)}
- Total Customers: ${customers.length}

CUSTOMER SEGMENTS:
- Loyal (30+ visits): ${segmentCounts.loyal}
- Regular (10-30 visits): ${segmentCounts.regular}
- Inactive (not visited 30+ days): ${segmentCounts.inactive}
- New (<10 visits): ${segmentCounts.new}

TOP PRODUCTS BY REVENUE:
${Array.from(productRevenue.entries())
  .sort(([, a], [, b]) => b - a)
  .slice(0, 8)
  .map(([name, rev]) => `- ${name}: ₹${Math.round(rev).toLocaleString('en-IN')}`)
  .join('\n')}

HOURLY TRANSACTION DISTRIBUTION:
${Array.from(hourlyTxns.entries())
  .sort(([a], [b]) => a - b)
  .map(([hour, count]) => `- ${hour}:00: ${count} transactions`)
  .join('\n')}

RECENT CAMPAIGNS:
${campaigns.map((c) => {
  const r = resultMap.get(c._id.toString());
  return `- ${c.name} (${c.status}): Cost ₹${c.actualCost || c.budgetAmount}, Profit ₹${c.actualProfit || c.estimatedProfit}${r ? `, ROI ${r.merchantRoi}%` : ''}`;
}).join('\n') || 'No campaigns yet'}
`.trim();
}

const recommendationSchema = z.object({
  campaignName: z.string(),
  description: z.string(),
  type: z.enum(['discount', 'combo', 'loyalty', 'reactivation']),
  targetSegment: z.enum(['inactive', 'regular', 'loyal', 'new', 'all']),
  durationDays: z.number().int().min(1).max(60),
  daysOfWeek: z.string().regex(/^[1-7](,[1-7])*$/),
  timeSlotStart: z.number().int().min(0).max(23),
  timeSlotEnd: z.number().int().min(0).max(23),
  discountPercent: z.number().min(0).max(50).nullable(),
  reasoning: z.string(),
});

export async function generateRecommendation(opportunity: {
  type: string;
  title: string;
  description: string;
  metrics: Record<string, any>;
}) {
  const fallback = {
    campaignName: `Growth Campaign: ${opportunity.title}`,
    description: `Targeted campaign to address ${opportunity.type.replace(/_/g, ' ')}. ${opportunity.description}`,
    type: opportunity.type === 'inactive_customers' ? 'reactivation' as const : 'combo' as const,
    targetSegment: opportunity.type === 'inactive_customers' ? 'inactive' as const : 'regular' as const,
    durationDays: 14,
    daysOfWeek: '1,2,3,4',
    timeSlotStart: 14,
    timeSlotEnd: 17,
    discountPercent: 15,
    reasoning: `This recommendation addresses the detected issue: ${opportunity.description}`,
  };

  if (!getSarvam()) return fallback;

  const context = await getMerchantContext();

  const systemPrompt = `You are a business growth advisor for a Paytm merchant.
HARD RULE: All financial numbers (ROI, incremental profit, campaign cost, revenue) are computed by the server, NOT by you. You must NEVER calculate, estimate, or invent any financial figures. You may only suggest campaign parameters (duration, time slots, discount percentage, target segment). Financial projections are handled separately by the campaign simulator.`;

  const userPrompt = `Based on the detected opportunity and merchant data, generate campaign parameters.

${context}

DETECTED OPPORTUNITY:
Type: ${opportunity.type}
Title: ${opportunity.title}
Description: ${opportunity.description}
Metrics: ${JSON.stringify(opportunity.metrics)}

Respond with ONLY a JSON object:
{
  "campaignName": "Short catchy name",
  "description": "2-3 sentence campaign description",
  "type": "discount|combo|loyalty|reactivation",
  "targetSegment": "inactive|regular|loyal|new|all",
  "durationDays": number (1-60),
  "daysOfWeek": "1,2,3,4,5" (comma-separated, Mon=1 Sun=7),
  "timeSlotStart": hour (0-23),
  "timeSlotEnd": hour (0-23),
  "discountPercent": number (0-50) or null,
  "reasoning": "Why this campaign addresses the opportunity"
}`;

  try {
    const text = await sarvamChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 0.3);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = recommendationSchema.parse(parsed);

    return {
      ...validated,
      durationDays: Math.min(60, Math.max(1, validated.durationDays)),
      timeSlotStart: Math.min(23, Math.max(0, validated.timeSlotStart)),
      timeSlotEnd: Math.min(23, Math.max(0, validated.timeSlotEnd)),
      discountPercent: validated.discountPercent !== null
        ? Math.min(50, Math.max(0, validated.discountPercent))
        : null,
    };
  } catch {
    return fallback;
  }
}

export async function chatWithAssistant(
  message: string,
  language = 'en-IN',
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
) {
  const context = await getMerchantContext();

  if (!getSarvam()) {
    return {
      response: `Based on your business data, here's what I can share:\n\nYour café has been performing steadily with transactions across the day. I notice your afternoon slot (2-5 PM) has room for growth. Your loyal customer base is solid, but there are inactive customers worth re-engaging.\n\nFor a detailed AI-powered analysis, please configure your Sarvam API key.`,
      dataUsed: ['transactions', 'customers', 'products'],
    };
  }

  const langName = language === 'en-IN' ? 'English' : language;

  const systemPrompt = `You are an AI business assistant for a Paytm merchant. Use the merchant's real business data to answer questions with specific insights and actionable advice.

HARD RULE: All financial numbers (ROI, incremental profit, campaign cost, revenue) shown here come from deterministic server-side calculations. You must NEVER calculate, estimate, or invent any financial figures. You may only reference and explain the numbers provided in the merchant context below. Use ₹ for currency.

Answer directly in ${langName} (use native script, not transliteration). Keep response under 200 words.

${context}`;

  const recentHistory = history.slice(-6);

  try {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message },
    ];

    const response = await sarvamChat(messages, 0.4);

    return {
      response,
      dataUsed: ['transactions', 'customers', 'products', 'campaigns'],
    };
  } catch {
    return {
      response: 'I encountered an issue processing your question. Please try again.',
      dataUsed: [],
    };
  }
}
