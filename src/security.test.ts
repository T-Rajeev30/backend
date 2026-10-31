import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSecurityHooks } from './security.js';

test('unauthenticated protected requests fail while health stays public', async () => {
  const app = Fastify();
  registerSecurityHooks(app, ['http://localhost:3000']);
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/private', async () => ({ secret: true }));
  await app.ready();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/private' })).statusCode, 401);
  } finally { await app.close(); }
});

test('login and registration reject origins outside the configured frontend', async () => {
  const app = Fastify();
  registerSecurityHooks(app, ['http://localhost:3000']);
  app.post('/api/auth/login', async () => ({ ok: true }));
  await app.ready();
  try {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://attacker.example' } });
    assert.equal(response.statusCode, 403);
  } finally { await app.close(); }
});
