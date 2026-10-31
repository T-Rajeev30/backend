import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';
import { connectDB } from './db/connection.js';
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
import { merchantRoutes } from './routes/merchants.js';
import { authRoutes } from './routes/auth.js';
import { demoCallRoutes, telephonyWebhookRoutes } from './routes/demo-call.js';
import { registerSecurityHooks } from './security.js';
import { registerVoiceWebSocket } from './services/voice-stream.js';
import { registerExotelMediaWebSocket } from './services/telephony/exotel-media-stream.js';

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
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-merchant-id', 'x-csrf-token'],
});

registerSecurityHooks(app, corsOrigins);
registerVoiceWebSocket(app, corsOrigins);
registerExotelMediaWebSocket(app);

// Register routes
app.register(authRoutes, { prefix: '/api/auth' });
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
app.register(merchantRoutes, { prefix: '/api/merchants' });
app.register(demoCallRoutes, { prefix: '/api/campaigns' });
app.register(telephonyWebhookRoutes, { prefix: '/api/telephony' });

app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Global error handler — return error message in response for debugging
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = Number((error as Error & { statusCode?: number }).statusCode) || 500;
  const message = statusCode < 500 ? error.message : 'Internal server error';
  reply.status(statusCode).send({ error: message });
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
