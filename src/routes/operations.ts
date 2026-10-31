import { FastifyInstance } from 'fastify';
import { Transaction, Product } from '../db/models.js';
import { getRequestMerchantId } from '../db/helpers.js';

export async function operationsRoutes(app: FastifyInstance) {

  // GET /api/operations/forecast — predict tomorrow's demand by product and time slot
  app.get('/forecast', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomorrowDow = tomorrow.getDay();

    // Get last 8 weeks of same-weekday transactions
    const eightWeeksAgo = new Date(now.getTime() - 56 * 86400000);
    const txns = await Transaction.find({
      merchantId,
      timestamp: { $gte: eightWeeksAgo },
      dayOfWeek: tomorrowDow,
    }).lean();

    const products = await Product.find({ merchantId }).lean();
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    // Compute moving average per product per time slot
    const slots = [
      { name: 'Morning', start: 8, end: 11 },
      { name: 'Lunch', start: 11, end: 14 },
      { name: 'Afternoon', start: 14, end: 17 },
      { name: 'Evening', start: 17, end: 21 },
    ];

    // Count how many same-weekday dates we have
    const uniqueDates = new Set(txns.map((t) => t.timestamp.toISOString().split('T')[0]));
    const numWeeks = Math.max(uniqueDates.size, 1);

    const forecast: Array<{
      productName: string;
      category: string;
      slots: Array<{ slot: string; predictedUnits: number; confidence: { low: number; high: number }; avgRevenue: number }>;
      totalPredicted: number;
    }> = [];

    for (const product of products) {
      const pid = product._id.toString();
      const productTxns = txns.filter((t) => t.productId.toString() === pid);

      const slotData = slots.map((slot) => {
        const slotTxns = productTxns.filter((t) => t.hourOfDay >= slot.start && t.hourOfDay < slot.end);
        const totalUnits = slotTxns.reduce((s, t) => s + t.quantity, 0);
        const totalRevenue = slotTxns.reduce((s, t) => s + t.amount, 0);
        const avgUnits = totalUnits / numWeeks;
        const avgRevenue = totalRevenue / numWeeks;
        const stdDev = Math.sqrt(
          slotTxns.reduce((s, t) => s + Math.pow(t.quantity - avgUnits / Math.max(slotTxns.length / numWeeks, 1), 2), 0) / Math.max(slotTxns.length, 1)
        );

        return {
          slot: slot.name,
          predictedUnits: Math.round(avgUnits),
          confidence: {
            low: Math.max(0, Math.round(avgUnits - 1.5 * stdDev)),
            high: Math.round(avgUnits + 1.5 * stdDev),
          },
          avgRevenue: Math.round(avgRevenue),
        };
      });

      const totalPredicted = slotData.reduce((s, d) => s + d.predictedUnits, 0);
      if (totalPredicted > 0) {
        forecast.push({
          productName: product.name,
          category: product.category,
          slots: slotData,
          totalPredicted,
        });
      }
    }

    // Identify slow-moving products
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const recentTxns = await Transaction.find({ merchantId, timestamp: { $gte: thirtyDaysAgo } }).lean();
    const productOrderCount = new Map<string, number>();
    recentTxns.forEach((t) => {
      const pid = t.productId.toString();
      productOrderCount.set(pid, (productOrderCount.get(pid) || 0) + 1);
    });

    const avgOrders = recentTxns.length / Math.max(products.length, 1);
    const slowMoving = products
      .filter((p) => (productOrderCount.get(p._id.toString()) || 0) < avgOrders * 0.3)
      .map((p) => ({
        name: p.name,
        category: p.category,
        orders30d: productOrderCount.get(p._id.toString()) || 0,
      }));

    return {
      forecastDate: tomorrow.toISOString().split('T')[0],
      dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tomorrowDow],
      basedOnWeeks: numWeeks,
      forecast: forecast.sort((a, b) => b.totalPredicted - a.totalPredicted),
      slowMoving,
    };
  });
}
