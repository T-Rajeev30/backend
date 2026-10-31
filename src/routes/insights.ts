import { FastifyInstance } from 'fastify';
import { Transaction, Product, Customer } from '../db/models.js';
import { getRequestMerchantId } from '../db/helpers.js';
import { sarvamChat } from '../services/sarvam-client.js';

export async function insightsRoutes(app: FastifyInstance) {

  // GET /api/insights/briefing?language=en-IN
  app.get<{ Querystring: { language?: string } }>('/briefing', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const language = (req.query.language || 'en-IN') as string;

    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const yesterdayStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    const yesterdayEnd = new Date(yesterdayStart.getTime() + 86400000);

    const lastWeekSameDay = new Date(yesterdayStart.getTime() - 7 * 86400000);
    const lastWeekSameDayEnd = new Date(lastWeekSameDay.getTime() + 86400000);

    const [yesterdayTxns, lastWeekTxns, products, customers] = await Promise.all([
      Transaction.find({ merchantId, timestamp: { $gte: yesterdayStart, $lt: yesterdayEnd } }).lean(),
      Transaction.find({ merchantId, timestamp: { $gte: lastWeekSameDay, $lt: lastWeekSameDayEnd } }).lean(),
      Product.find({ merchantId }).lean(),
      Customer.find({ merchantId }).lean(),
    ]);

    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const yRevenue = yesterdayTxns.reduce((s, t) => s + t.amount, 0);
    const lwRevenue = lastWeekTxns.reduce((s, t) => s + t.amount, 0);
    const revenueChange = lwRevenue > 0 ? ((yRevenue - lwRevenue) / lwRevenue * 100) : 0;

    // Best and worst hour
    const hourlyMap = new Map<number, { revenue: number; count: number }>();
    yesterdayTxns.forEach((t) => {
      const existing = hourlyMap.get(t.hourOfDay) || { revenue: 0, count: 0 };
      existing.revenue += t.amount;
      existing.count += 1;
      hourlyMap.set(t.hourOfDay, existing);
    });

    let bestHour = { hour: 0, revenue: 0 };
    let worstHour = { hour: 0, revenue: Infinity };
    for (const [hour, data] of hourlyMap) {
      if (data.revenue > bestHour.revenue) bestHour = { hour, revenue: data.revenue };
      if (data.revenue < worstHour.revenue) worstHour = { hour, revenue: data.revenue };
    }
    if (worstHour.revenue === Infinity) worstHour = { hour: 0, revenue: 0 };

    // Top product
    const productRevenue = new Map<string, { name: string; revenue: number }>();
    yesterdayTxns.forEach((t) => {
      const pid = t.productId.toString();
      const product = productMap.get(pid);
      if (!product) return;
      const existing = productRevenue.get(pid) || { name: product.name, revenue: 0 };
      existing.revenue += t.amount;
      productRevenue.set(pid, existing);
    });
    const topProduct = Array.from(productRevenue.values()).sort((a, b) => b.revenue - a.revenue)[0];

    // Priority action
    const inactiveCount = customers.filter((c) => {
      const daysSince = (now.getTime() - new Date(c.lastVisit).getTime()) / 86400000;
      return daysSince > 30 && c.totalVisits >= 5;
    }).length;

    let priorityAction = 'Focus on promoting your top-selling items during peak hours.';
    if (revenueChange < -10) {
      priorityAction = `Revenue dropped ${Math.abs(Math.round(revenueChange))}% vs last week. Consider a flash offer during slow hours.`;
    } else if (inactiveCount > 10) {
      priorityAction = `${inactiveCount} regular customers haven't visited in 30+ days. Send a reactivation offer.`;
    }

    const facts = {
      yesterdayRevenue: Math.round(yRevenue),
      lastWeekRevenue: Math.round(lwRevenue),
      revenueChangePercent: Math.round(revenueChange * 10) / 10,
      transactions: yesterdayTxns.length,
      bestHour: { hour: bestHour.hour, revenue: Math.round(bestHour.revenue) },
      worstHour: { hour: worstHour.hour, revenue: Math.round(worstHour.revenue) },
      topProduct: topProduct ? { name: topProduct.name, revenue: Math.round(topProduct.revenue) } : null,
      inactiveCustomers: inactiveCount,
      priorityAction,
    };

    let briefingText: string;
    try {
      briefingText = await sarvamChat([
        {
          role: 'system',
          content: `You are a business briefing assistant for a Paytm merchant. Write a 3-sentence briefing in ${language === 'en-IN' ? 'English' : 'the language code ' + language}. HARD RULE: You must ONLY use the exact numbers provided below. Never calculate, invent, or change any financial figure. Simply narrate the data you are given.`,
        },
        {
          role: 'user',
          content: `Here are yesterday's facts:\n${JSON.stringify(facts, null, 2)}\n\nWrite a brief 3-sentence daily briefing for the merchant. Include the revenue comparison, best hour, top product, and the priority action. Use the exact numbers given.`,
        },
      ]);
    } catch {
      briefingText = `Yesterday's revenue was ₹${facts.yesterdayRevenue.toLocaleString('en-IN')} (${facts.revenueChangePercent > 0 ? '+' : ''}${facts.revenueChangePercent}% vs last week) from ${facts.transactions} transactions. Best hour was ${facts.bestHour.hour}:00 with ₹${facts.bestHour.revenue.toLocaleString('en-IN')}${facts.topProduct ? `, and ${facts.topProduct.name} was your top seller at ₹${facts.topProduct.revenue.toLocaleString('en-IN')}` : ''}. ${facts.priorityAction}`;
    }

    return { briefing: briefingText, facts, language };
  });
}
