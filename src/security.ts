import { FastifyInstance } from 'fastify';
import { authenticateRequest, verifyCsrf } from './db/helpers.js';

export function registerSecurityHooks(app: FastifyInstance, corsOrigins: string[]) {
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0];
    if (path === '/api/health' || path === '/api/translate/languages') return;
    // Telephony provider status webhook is authenticated by an unguessable
    // per-call token in the query string, not a session cookie. Exotel cannot
    // present an origin or CSRF token.
    if (path === '/api/telephony/exotel/status' && req.method === 'POST') return;
    if ((path === '/api/auth/login' || path === '/api/auth/register') && req.method === 'POST') {
      if (!req.headers.origin || !corsOrigins.includes(req.headers.origin)) {
        throw Object.assign(new Error('Invalid request origin'), { statusCode: 403 });
      }
      return;
    }
    const { session } = await authenticateRequest(req);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (!origin || !corsOrigins.includes(origin)) throw Object.assign(new Error('Invalid request origin'), { statusCode: 403 });
      verifyCsrf(req, session.csrfHash);
    }
  });
}
