import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';
import { connectDB } from './db/connection.js';
import { extractMerchantId } from './db/helpers.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { opportunityRoutes } from './routes/opportunities.js';
import { campaignRoutes } from './routes/campaigns.js';
import { aiAssistantRoutes } from './routes/ai-assistant.js';
import { translateRoutes } from './routes/translate.js';
import { voiceRoutes } from './routes/voice.js';
import { insightsRoutes } from './routes/insights.js';
import { operationsRoutes } from './routes/operations.js';
import { customersRoutes } from './routes/customers.js';
import { opsRoutes } from './routes/ops.js';

config();

const app = Fastify({
  logger: true,
  bodyLimit: 15 * 1024 * 1024,
});

const corsOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim());

await app.register(cors, {
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-merchant-id'],
});

// Register routes
app.register(dashboardRoutes, { prefix: '/api/dashboard' });
app.register(opportunityRoutes, { prefix: '/api/opportunities' });
app.register(campaignRoutes, { prefix: '/api/campaigns' });
app.register(aiAssistantRoutes, { prefix: '/api/ai' });
app.register(translateRoutes, { prefix: '/api/translate' });
app.register(voiceRoutes, { prefix: '/api/voice' });
app.register(insightsRoutes, { prefix: '/api/insights' });
app.register(operationsRoutes, { prefix: '/api/operations' });
app.register(customersRoutes, { prefix: '/api/customers' });
app.register(opsRoutes, { prefix: '/api/ops' });

app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Merchant list for switcher
app.get('/api/merchants', async () => {
  const { Merchant } = await import('./db/models.js');
  const merchants = await Merchant.find().sort({ createdAt: 1 }).lean();
  return { merchants: merchants.map((m) => ({ id: m._id, name: m.name, businessType: m.businessType, city: m.city })) };
});

// Global error handler — return error message in response for debugging
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.status(500).send({ error: error.message });
});

const port = parseInt(process.env.PORT || '3001');

async function start() {
  try {
    await connectDB();
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
