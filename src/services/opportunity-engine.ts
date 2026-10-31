import { Transaction, Customer, Product } from '../db/models.js';
import type { Types } from 'mongoose';

interface Opportunity {
  type: string;
  title: string;
  description: string;
  reasoning: string;
  severity: 'low' | 'medium' | 'high';
  metrics: Record<string, any>;
  suggestedAction: string;
  estimatedCost: number;
  estimatedProfit: number;
}

async function detectDecliningTimeslots(merchantId: Types.ObjectId): Promise<Opportunity[]> {
  const now = Date.now();
  const fourWeeksAgo = new Date(now - 28 * 86400000);
  const eightWeeksAgo = new Date(now - 56 * 86400000);

  const [recent, previous] = await Promise.all([
    Transaction.find({ merchantId, timestamp: { $gte: fourWeeksAgo } }).lean(),
    Transaction.find({ merchantId, timestamp: { $gte: eightWeeksAgo, $lt: fourWeeksAgo } }).lean(),
  ]);

  const opportunities: Opportunity[] = [];
  const slots = [
    { start: 8, end: 11, name: 'Morning (8–11 AM)' },
    { start: 11, end: 14, name: 'Lunch (11 AM–2 PM)' },
    { start: 14, end: 17, name: 'Afternoon (2–5 PM)' },
    { start: 17, end: 21, name: 'Evening (5–9 PM)' },
  ];

  for (const slot of slots) {
    const recentSlot = recent.filter(
      (t) => t.hourOfDay >= slot.start && t.hourOfDay < slot.end && t.dayOfWeek >= 1 && t.dayOfWeek <= 5
    );
    const prevSlot = previous.filter(
      (t) => t.hourOfDay >= slot.start && t.hourOfDay < slot.end && t.dayOfWeek >= 1 && t.dayOfWeek <= 5
    );

    if (prevSlot.length < 10) continue;

    const recentRevenue = recentSlot.reduce((s, t) => s + t.amount, 0);
    const prevRevenue = prevSlot.reduce((s, t) => s + t.amount, 0);
    const changePercent = ((recentRevenue - prevRevenue) / prevRevenue) * 100;

    if (changePercent < -10) {
      const declineAmount = Math.round(prevRevenue - recentRevenue);
      const severity = changePercent < -25 ? 'high' : changePercent < -15 ? 'medium' : 'low';

      opportunities.push({
        type: 'declining_sales',
        title: `Weekday ${slot.name} Sales Declining`,
        description: `Weekday sales during ${slot.name} have declined by ${Math.abs(Math.round(changePercent))}% compared to the previous 4-week baseline, representing ₹${declineAmount.toLocaleString('en-IN')} in lost revenue.`,
        reasoning: `Analysis compared ${recentSlot.length} transactions (last 4 weeks) against ${prevSlot.length} transactions (previous 4 weeks) during weekday ${slot.name} hours. Recent revenue: ₹${Math.round(recentRevenue).toLocaleString('en-IN')} vs Previous: ₹${Math.round(prevRevenue).toLocaleString('en-IN')}.`,
        severity,
        metrics: {
          recentTransactions: recentSlot.length,
          previousTransactions: prevSlot.length,
          recentRevenue: Math.round(recentRevenue),
          previousRevenue: Math.round(prevRevenue),
          changePercent: Math.round(changePercent),
          lostRevenue: declineAmount,
          timeSlot: `${slot.start}:00–${slot.end}:00`,
        },
        suggestedAction: `Launch a targeted combo offer during weekday ${slot.name} to win back customers.`,
        estimatedCost: Math.round(declineAmount * 0.4),
        estimatedProfit: Math.round(declineAmount * 0.85),
      });
    }
  }

  return opportunities;
}

async function detectInactiveCustomers(merchantId: Types.ObjectId): Promise<Opportunity[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

  const inactiveCustomers = await Customer.find({
    merchantId,
    lastVisit: { $lt: thirtyDaysAgo },
    totalVisits: { $gte: 5 },
  }).lean();

  if (inactiveCustomers.length < 5) return [];

  const avgSpent = inactiveCustomers.reduce((s, c) => s + c.totalSpent, 0) / inactiveCustomers.length;
  const totalLostRevenue = Math.round(inactiveCustomers.length * (avgSpent / 12));

  return [{
    type: 'inactive_customers',
    title: `${inactiveCustomers.length} Previously Regular Customers Gone Inactive`,
    description: `${inactiveCustomers.length} customers who averaged ${Math.round(avgSpent / inactiveCustomers[0].totalVisits)} per visit haven't returned in over 30 days. Estimated monthly revenue at risk: ₹${totalLostRevenue.toLocaleString('en-IN')}.`,
    reasoning: `Identified customers with 5+ historical visits whose last visit was more than 30 days ago. These were previously engaged customers showing a pattern of disengagement.`,
    severity: inactiveCustomers.length > 30 ? 'high' : 'medium',
    metrics: {
      inactiveCount: inactiveCustomers.length,
      avgLifetimeSpend: Math.round(avgSpent),
      estimatedMonthlyLoss: totalLostRevenue,
      avgVisitsBeforeInactive: Math.round(
        inactiveCustomers.reduce((s, c) => s + c.totalVisits, 0) / inactiveCustomers.length
      ),
    },
    suggestedAction: 'Send a personalized reactivation offer with a time-limited discount to bring these customers back.',
    estimatedCost: Math.round(inactiveCustomers.length * 50),
    estimatedProfit: Math.round(totalLostRevenue * 0.6),
  }];
}

async function detectUnderperformingProducts(merchantId: Types.ObjectId): Promise<Opportunity[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

  const txns = await Transaction.find({ merchantId, timestamp: { $gte: thirtyDaysAgo } }).lean();
  const products = await Product.find({ merchantId }).lean();
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  const byCategory = new Map<string, Map<string, { name: string; revenue: number; orders: number }>>();

  txns.forEach((t) => {
    const product = productMap.get(t.productId.toString());
    if (!product) return;
    if (!byCategory.has(product.category)) byCategory.set(product.category, new Map());
    const catMap = byCategory.get(product.category)!;
    const pid = t.productId.toString();
    const existing = catMap.get(pid) || { name: product.name, revenue: 0, orders: 0 };
    existing.revenue += t.amount;
    existing.orders += 1;
    catMap.set(pid, existing);
  });

  const opportunities: Opportunity[] = [];

  for (const [category, prods] of byCategory) {
    if (prods.size < 2) continue;
    const items = Array.from(prods.values());
    const avgRevenue = items.reduce((s, i) => s + i.revenue, 0) / items.length;

    for (const item of items) {
      if (item.revenue < avgRevenue * 0.4 && item.orders > 0) {
        opportunities.push({
          type: 'underperforming_product',
          title: `${item.name} Underperforming in ${category}`,
          description: `${item.name} generated only ₹${Math.round(item.revenue).toLocaleString('en-IN')} (${item.orders} orders) — ${Math.round((item.revenue / avgRevenue) * 100)}% of the category average.`,
          reasoning: `Compared against ${items.length} products in the "${category}" category. Category average revenue: ₹${Math.round(avgRevenue).toLocaleString('en-IN')}. ${item.name} is significantly below average.`,
          severity: 'low',
          metrics: {
            productName: item.name,
            category,
            revenue: Math.round(item.revenue),
            orders: item.orders,
            categoryAverage: Math.round(avgRevenue),
            percentOfAverage: Math.round((item.revenue / avgRevenue) * 100),
          },
          suggestedAction: `Consider bundling ${item.name} into a combo or running a promotional offer to boost sales.`,
          estimatedCost: 1500,
          estimatedProfit: 3500,
        });
      }
    }
  }

  return opportunities.slice(0, 2);
}

async function detectAovOpportunity(merchantId: Types.ObjectId): Promise<Opportunity[]> {
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
  const eightWeeksAgo = new Date(Date.now() - 56 * 86400000);

  const [recent, previous] = await Promise.all([
    Transaction.find({ merchantId, timestamp: { $gte: fourWeeksAgo } }).lean(),
    Transaction.find({ merchantId, timestamp: { $gte: eightWeeksAgo, $lt: fourWeeksAgo } }).lean(),
  ]);

  if (recent.length === 0 || previous.length === 0) return [];

  const recentAov = recent.reduce((s, t) => s + t.amount, 0) / recent.length;
  const prevAov = previous.reduce((s, t) => s + t.amount, 0) / previous.length;
  const singleItemTxns = recent.filter((t) => t.quantity === 1).length;
  const singleItemPct = (singleItemTxns / recent.length) * 100;

  if (singleItemPct > 60) {
    return [{
      type: 'low_aov',
      title: 'Opportunity to Increase Average Order Value',
      description: `${Math.round(singleItemPct)}% of recent orders are single-item purchases. Current AOV is ₹${Math.round(recentAov)}. A combo strategy could lift this significantly.`,
      reasoning: `${singleItemTxns} out of ${recent.length} recent transactions contain only 1 item. Average order value: ₹${Math.round(recentAov)} (previous period: ₹${Math.round(prevAov)}). High single-item ratio suggests customers aren't discovering complementary products.`,
      severity: 'medium',
      metrics: {
        currentAov: Math.round(recentAov),
        previousAov: Math.round(prevAov),
        singleItemPercent: Math.round(singleItemPct),
        singleItemOrders: singleItemTxns,
        totalOrders: recent.length,
      },
      suggestedAction: 'Introduce combo deals pairing coffee with snacks/desserts to increase basket size.',
      estimatedCost: 3000,
      estimatedProfit: 7500,
    }];
  }

  return [];
}

export async function runOpportunityDetection(merchantId: Types.ObjectId): Promise<Opportunity[]> {
  const [timeslots, inactive, products, aov] = await Promise.all([
    detectDecliningTimeslots(merchantId),
    detectInactiveCustomers(merchantId),
    detectUnderperformingProducts(merchantId),
    detectAovOpportunity(merchantId),
  ]);

  return [...timeslots, ...inactive, ...products, ...aov].sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}
