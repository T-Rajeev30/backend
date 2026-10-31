import { FastifyInstance } from 'fastify';
import { getMetrics } from '../services/ai-ops-metrics.js';

export async function opsRoutes(app: FastifyInstance) {
  app.get('/ai-metrics', async () => getMetrics());
}
