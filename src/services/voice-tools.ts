import { z } from 'zod';
import { Types } from 'mongoose';
import { Campaign, CampaignResult, Customer, Merchant, Product, Transaction, AiRecommendation } from '../db/models.js';

const common = z.object({}).strict();
export const voiceToolSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('today_sales') }).strict(),
  z.object({ tool: z.literal('historical_sales'), days: z.number().int().min(1).max(90).default(7) }).strict(),
  z.object({ tool: z.literal('gross_profit'), days: z.number().int().min(1).max(90).default(30) }).strict(),
  z.object({ tool: z.literal('top_products'), days: z.number().int().min(1).max(90).default(30) }).strict(),
  z.object({ tool: z.literal('customer_segments') }).strict(),
  z.object({ tool: z.literal('campaign_performance') }).strict(),
  z.object({ tool: z.literal('opportunities') }).strict(),
  z.object({ tool: z.literal('merchant_settings') }).strict(),
  z.object({
    tool: z.literal('create_campaign_draft'), name: z.string().trim().min(2).max(100),
    segment: z.enum(['inactive', 'regular', 'loyal', 'new', 'all']),
    budgetAmount: z.number().finite().min(0).max(10_000_000),
  }).strict(),
]);
export type VoiceToolInput = z.infer<typeof voiceToolSchema>;

function evidence(source: string, period: string, valuesStatus: 'measured' | 'estimate' = 'measured') {
  return { source, period, valuesStatus, calculatedAt: new Date().toISOString() };
}

export async function runVoiceTool(merchantId: Types.ObjectId, raw: unknown) {
  const parsed = voiceToolSchema.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error('Invalid tool arguments'), { statusCode: 400 });
  const input = parsed.data;
  const now = new Date();

  if (input.tool === 'today_sales') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await Transaction.find({ merchantId, timestamp: { $gte: start, $lte: now } }).select('amount timestamp').lean();
    const revenue = rows.reduce((sum, row) => sum + row.amount, 0);
    return { tool: input.tool, result: { revenue: Math.round(revenue), transactions: rows.length, currency: 'INR' }, evidence: [evidence('transactions', 'Today (UTC)')] };
  }
  if (input.tool === 'historical_sales') {
    const windowMs = input.days * 86400000;
    const currentStart = new Date(now.getTime() - windowMs);
    const previousStart = new Date(currentStart.getTime() - windowMs);
    const rows = await Transaction.find({ merchantId, timestamp: { $gte: previousStart, $lte: now } }).select('amount timestamp').lean();
    const current = rows.filter((row) => row.timestamp >= currentStart).reduce((sum, row) => sum + row.amount, 0);
    const previous = rows.filter((row) => row.timestamp < currentStart).reduce((sum, row) => sum + row.amount, 0);
    return { tool: input.tool, result: { days: input.days, currentRevenue: Math.round(current), previousRevenue: Math.round(previous), changeAmount: Math.round(current - previous), currency: 'INR' }, evidence: [evidence('transactions', `Last ${input.days} days vs prior ${input.days} days`)] };
  }
  if (input.tool === 'gross_profit') {
    const since = new Date(now.getTime() - input.days * 86400000);
    const [transactions, products] = await Promise.all([
      Transaction.find({ merchantId, timestamp: { $gte: since, $lte: now } }).select('productId amount quantity').lean(),
      Product.find({ merchantId }).select('name cost').lean(),
    ]);
    const costs = new Map(products.map((product) => [product._id.toString(), product.cost]));
    const unknownCostCount = transactions.filter((row) => !costs.has(row.productId.toString())).length;
    const grossProfit = transactions.reduce((sum, row) => {
      const cost = costs.get(row.productId.toString());
      return sum + (cost === undefined ? 0 : row.amount - cost * row.quantity);
    }, 0);
    return { tool: input.tool, result: { days: input.days, grossProfit: Math.round(grossProfit), currency: 'INR', complete: unknownCostCount === 0, missingCostTransactions: unknownCostCount }, evidence: [evidence('transactions + product catalog costs', `Last ${input.days} days`, unknownCostCount ? 'estimate' : 'measured')] };
  }
  if (input.tool === 'top_products') {
    const since = new Date(now.getTime() - input.days * 86400000);
    const [transactions, products] = await Promise.all([
      Transaction.find({ merchantId, timestamp: { $gte: since, $lte: now } }).select('productId amount quantity').lean(),
      Product.find({ merchantId }).select('name').lean(),
    ]);
    const names = new Map(products.map((product) => [product._id.toString(), product.name]));
    const totals = new Map<string, { revenue: number; units: number }>();
    for (const row of transactions) {
      const id = row.productId.toString();
      const current = totals.get(id) || { revenue: 0, units: 0 };
      current.revenue += row.amount; current.units += row.quantity; totals.set(id, current);
    }
    const top = [...totals].map(([id, value]) => ({ product: names.get(id) || 'Product', ...value }))
      .sort((a, b) => b.revenue - a.revenue).slice(0, 5)
      .map((row) => ({ ...row, revenue: Math.round(row.revenue) }));
    return { tool: input.tool, result: { days: input.days, products: top, currency: 'INR' }, evidence: [evidence('transactions + product catalog', `Last ${input.days} days`)] };
  }
  if (input.tool === 'customer_segments') {
    const [segments, eligible] = await Promise.all([
      Customer.aggregate([{ $match: { merchantId } }, { $group: { _id: '$segment', count: { $sum: 1 } } }]),
      Customer.countDocuments({ merchantId, consentSms: true }),
    ]);
    return { tool: input.tool, result: { segments: Object.fromEntries(segments.map((row) => [row._id, row.count])), eligibleMessagingAudience: eligible }, evidence: [evidence('customer records + messaging consent', 'Current')] };
  }
  if (input.tool === 'campaign_performance') {
    const campaigns = await Campaign.find({ merchantId }).sort({ createdAt: -1 }).limit(10).select('name status createdAt').lean();
    const results = await CampaignResult.find({ campaignId: { $in: campaigns.map((item) => item._id) } }).lean();
    const resultMap = new Map(results.map((item) => [item.campaignId.toString(), item]));
    return { tool: input.tool, result: { campaigns: campaigns.map((item) => {
      const result = resultMap.get(item._id.toString());
      return { name: item.name, status: item.status, simulated: Boolean(result), ...(result ? { incrementalGrossProfit: result.incrementalProfit, roiPercent: result.merchantRoi } : {}) };
    }) }, evidence: [evidence('campaigns + campaign results', 'Latest 10 campaigns')] };
  }
  if (input.tool === 'opportunities') {
    const items = await AiRecommendation.find({ merchantId, status: { $in: ['new', 'viewed'] } }).sort({ createdAt: -1 }).limit(10).select('title description severity status metrics').lean();
    return { tool: input.tool, result: { opportunities: items }, evidence: [evidence('AI recommendations', 'Current; opportunity estimates are not guaranteed outcomes', 'estimate')] };
  }
  if (input.tool === 'merchant_settings') {
    const merchant = await Merchant.findById(merchantId).select('name businessType address city dataMode').lean();
    if (!merchant) throw Object.assign(new Error('Merchant unavailable'), { statusCode: 404 });
    return { tool: input.tool, result: { name: merchant.name, businessType: merchant.businessType, address: merchant.address, city: merchant.city, dataMode: merchant.dataMode || 'simulated' }, evidence: [evidence('merchant profile', 'Current')] };
  }
  const campaign = await Campaign.create({
    merchantId, name: input.name, description: 'Voice assistant draft; requires merchant review and approval.',
    type: 'discount', status: 'pending', targetSegment: input.segment,
    channel: 'message', startDate: now, endDate: new Date(now.getTime() + 14 * 86400000), budgetAmount: input.budgetAmount,
  });
  return { tool: input.tool, result: { campaignId: campaign._id.toString(), name: campaign.name, status: campaign.status, budgetAmount: campaign.budgetAmount, actionTaken: 'Draft created only; no approval, delivery, or spend occurred.' }, evidence: [evidence('campaign draft', 'Created now', 'estimate')] };
}

export function inferVoiceTool(text: string): VoiceToolInput | { clarification: string } | null {
  const value = text.toLowerCase();
  if (/today.*(sales|revenue)|(sales|revenue).*(today)|आज.*(बिक्री|सेल)|ಇಂದು.*(ಮಾರಾಟ|ಸೇಲ್)/i.test(value)) return { tool: 'today_sales' };
  if (/gross profit|profit|ಲಾಭ|मुनाफा|लाभ/i.test(value)) return { tool: 'gross_profit', days: 30 };
  if (/compare|comparison|compared|पिछले|ಹೋಲಿಸು/i.test(value)) return { tool: 'historical_sales', days: 7 };
  if (/top products|best.?selling|popular products|सबसे ज़्यादा बिक|ಹೆಚ್ಚು ಮಾರಾಟ/i.test(value)) return { tool: 'top_products', days: 30 };
  if (/customer segment|eligible audience|customers.*(segment|count)|ग्राहक.*(संख्या|सेगमेंट)|ಗ್ರಾಹಕ.*(ವಿಭಾಗ|ಸಂಖ್ಯೆ)/i.test(value)) return { tool: 'customer_segments' };
  if (/campaign.*(performance|result|roi)|अभियान.*(प्रदर्शन|नतीजे)|ಅಭಿಯಾನ.*(ಫಲಿತಾಂಶ|ಕಾರ್ಯಕ್ಷಮತೆ)/i.test(value)) return { tool: 'campaign_performance' };
  if (/opportunit|suggestion|recommendation|अवसर|सुझाव|ಅವಕಾಶ|ಸಲಹೆ/i.test(value)) return { tool: 'opportunities' };
  if (/merchant settings|business settings|my address|ಮಳಿಗೆ ವಿವರ|व्यापार सेटिंग/i.test(value)) return { tool: 'merchant_settings' };
  if (/draft|create.*campaign|campaign.*for|अभियान.*बन|ಅಭಿಯಾನ.*ಮಾಡು/i.test(value)) {
    const budget = value.match(/(?:₹|rs\.?\s*|rupees?\s*)([\d,]+)/i)?.[1]?.replaceAll(',', '');
    if (!budget) return { clarification: 'What budget amount should I put in this draft? It will remain pending approval.' };
    const segment = /inactive|निष्क्रिय|ನಿಷ್ಕ್ರಿಯ/.test(value) ? 'inactive'
      : /loyal|वफादार|ನಿಷ್ಠಾವಂತ/.test(value) ? 'loyal'
      : /new|नए ग्राहक|ಹೊಸ ಗ್ರಾಹಕ/.test(value) ? 'new' : 'all';
    const name = `Voice draft ${new Date().toLocaleDateString('en-IN')}`;
    return { tool: 'create_campaign_draft', name, segment, budgetAmount: Number(budget) };
  }
  return null;
}
