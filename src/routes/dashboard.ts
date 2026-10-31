import { FastifyInstance } from 'fastify';
import { Transaction, Customer, Product } from '../db/models.js';
import { getRequestMerchantId } from '../db/helpers.js';

export async function dashboardRoutes(app: FastifyInstance) {

  // GET /api/dashboard/stats
  app.get('/stats', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000);

    const [currentTxns, previousTxns, customers, productCount] = await Promise.all([
      Transaction.find({ merchantId, timestamp: { $gte: thirtyDaysAgo } }).lean(),
      Transaction.find({ merchantId, timestamp: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } }).lean(),
      Customer.find({ merchantId }).lean(),
      Product.countDocuments({ merchantId }),
    ]);

    const totalRevenue = currentTxns.reduce((s, t) => s + t.amount, 0);
    const prevRevenue = previousTxns.reduce((s, t) => s + t.amount, 0);
    const avgOrderValue = currentTxns.length > 0 ? totalRevenue / currentTxns.length : 0;
    const prevAov = previousTxns.length > 0 ? prevRevenue / previousTxns.length : 0;

    const returningCustomers = customers.filter((c) => c.totalVisits > 1).length;
    const prevReturning = customers.filter(
      (c) => c.totalVisits > 1 && c.lastVisit < thirtyDaysAgo && c.lastVisit >= sixtyDaysAgo
    ).length;

    return {
      totalRevenue: Math.round(totalRevenue),
      revenueChange: prevRevenue > 0 ? parseFloat(((totalRevenue - prevRevenue) / prevRevenue * 100).toFixed(1)) : 0,
      totalTransactions: currentTxns.length,
      transactionChange: previousTxns.length > 0
        ? parseFloat(((currentTxns.length - previousTxns.length) / previousTxns.length * 100).toFixed(1))
        : 0,
      avgOrderValue: Math.round(avgOrderValue),
      aovChange: prevAov > 0 ? parseFloat(((avgOrderValue - prevAov) / prevAov * 100).toFixed(1)) : 0,
      returningCustomers,
      returningChange: prevReturning > 0
        ? parseFloat(((returningCustomers - prevReturning) / prevReturning * 100).toFixed(1))
        : 0,
      totalCustomers: customers.length,
      totalProducts: productCount,
    };
  });

  // GET /api/dashboard/sales-chart
  app.get('/sales-chart', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const { period = 'daily' } = req.query as { period?: string };
    const daysBack = period === 'weekly' ? 56 : 30;
    const since = new Date(Date.now() - daysBack * 86400000);

    const txns = await Transaction.find({ merchantId, timestamp: { $gte: since } })
      .sort({ timestamp: 1 })
      .lean();

    if (period === 'weekly') {
      const weekMap = new Map<string, { revenue: number; transactions: number }>();
      txns.forEach((t) => {
        const weekStart = new Date(t.timestamp);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const key = weekStart.toISOString().split('T')[0];
        const existing = weekMap.get(key) || { revenue: 0, transactions: 0 };
        existing.revenue += t.amount;
        existing.transactions += 1;
        weekMap.set(key, existing);
      });
      return Array.from(weekMap.entries()).map(([date, data]) => ({
        date,
        label: `Week of ${date}`,
        revenue: Math.round(data.revenue),
        transactions: data.transactions,
      }));
    }

    const dayMap = new Map<string, { revenue: number; transactions: number }>();
    txns.forEach((t) => {
      const key = t.timestamp.toISOString().split('T')[0];
      const existing = dayMap.get(key) || { revenue: 0, transactions: 0 };
      existing.revenue += t.amount;
      existing.transactions += 1;
      dayMap.set(key, existing);
    });

    return Array.from(dayMap.entries()).map(([date, data]) => ({
      date,
      revenue: Math.round(data.revenue),
      transactions: data.transactions,
    }));
  });

  // GET /api/dashboard/hourly-distribution
  app.get('/hourly-distribution', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
    const eightWeeksAgo = new Date(Date.now() - 56 * 86400000);

    const [recentTxns, previousTxns] = await Promise.all([
      Transaction.find({ merchantId, timestamp: { $gte: fourWeeksAgo } }).lean(),
      Transaction.find({ merchantId, timestamp: { $gte: eightWeeksAgo, $lt: fourWeeksAgo } }).lean(),
    ]);

    const hours = Array.from({ length: 24 }, (_, i) => {
      const recent = recentTxns.filter((t) => t.hourOfDay === i);
      const previous = previousTxns.filter((t) => t.hourOfDay === i);
      return {
        hour: i,
        label: `${i.toString().padStart(2, '0')}:00`,
        currentTransactions: recent.length,
        previousTransactions: previous.length,
        currentRevenue: Math.round(recent.reduce((s, t) => s + t.amount, 0)),
        previousRevenue: Math.round(previous.reduce((s, t) => s + t.amount, 0)),
        change: previous.length > 0
          ? parseFloat(((recent.length - previous.length) / previous.length * 100).toFixed(1))
          : 0,
      };
    });

    return hours.filter((h) => h.currentTransactions > 0 || h.previousTransactions > 0);
  });

  // GET /api/dashboard/top-products
  app.get('/top-products', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

    const txns = await Transaction.find({ merchantId, timestamp: { $gte: thirtyDaysAgo } }).lean();
    const products = await Product.find({ merchantId }).lean();
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const statsMap = new Map<string, { name: string; revenue: number; orders: number; category: string }>();
    txns.forEach((t) => {
      const pid = t.productId.toString();
      const product = productMap.get(pid);
      if (!product) return;
      const existing = statsMap.get(pid) || { name: product.name, revenue: 0, orders: 0, category: product.category };
      existing.revenue += t.amount;
      existing.orders += 1;
      statsMap.set(pid, existing);
    });

    return Array.from(statsMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((p) => ({ ...p, revenue: Math.round(p.revenue) }));
  });

  // GET /api/dashboard/customer-segments
  app.get('/customer-segments', async (req) => {
    const merchantId = await getRequestMerchantId(req);
    const customers = await Customer.find({ merchantId }).lean();
    const segments = { loyal: 0, regular: 0, inactive: 0, new: 0 };
    if (customers.length === 0) return [];
    customers.forEach((c) => {
      segments[c.segment as keyof typeof segments] += 1;
    });
    return Object.entries(segments).map(([name, count]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      count,
      percentage: parseFloat(((count / customers.length) * 100).toFixed(1)),
    }));
  });
}
