import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import mongoose from 'mongoose';
import { registerSecurityHooks } from '../security.js';
import { authRoutes } from './auth.js';
import { campaignRoutes } from './campaigns.js';
import { customersRoutes } from './customers.js';
import { merchantRoutes } from './merchants.js';
import { aiAssistantRoutes } from './ai-assistant.js';
import { AuthSession, AuthUser, Campaign, CampaignResult, CampaignTarget, Customer, Merchant, MerchantMembership, RegistrationInvite } from '../db/models.js';
import { hashToken } from '../db/helpers.js';
import { authorizeVoiceConnection } from '../services/voice-stream.js';

const mongoUri = process.env.TEST_MONGODB_URI;
const scrypt = promisify(scryptCallback);

test('session auth, merchant membership, header spoofing, and role checks', { skip: !mongoUri }, async () => {
  const app = Fastify();
  const origin = 'http://localhost:3000';
  const ids: Record<string, mongoose.Types.ObjectId[]> = { users: [], merchants: [], campaigns: [], customers: [], sessions: [], invites: [] };
  const sessions: Record<string, string> = {};
  const csrfTokens: Record<string, string> = {};
  try {
    await mongoose.connect(mongoUri!, { dbName: 'merchant_autopilot_test' });
    registerSecurityHooks(app, [origin]);
    app.register(authRoutes, { prefix: '/api/auth' });
    app.register(campaignRoutes, { prefix: '/api/campaigns' });
    app.register(customersRoutes, { prefix: '/api/customers' });
    app.register(merchantRoutes, { prefix: '/api/merchants' });
    app.register(aiAssistantRoutes, { prefix: '/api/ai' });
    await app.ready();

    const merchants = await Merchant.create([
      { name: `Auth test A ${Date.now()}`, businessType: 'test', dataMode: 'simulated' },
      { name: `Auth test B ${Date.now()}`, businessType: 'test', dataMode: 'simulated' },
    ]);
    const [merchantA, merchantB] = merchants;
    ids.merchants = merchants.map((item) => item._id);
    const salt = randomBytes(16).toString('hex');
    const testPassword = 'Test password 123!';
    const passwordHash = await scrypt(testPassword, salt, 64) as Buffer;
    const users = await AuthUser.create([
      { email: `owner-${Date.now()}@test.invalid`, passwordHash: `${salt}:${passwordHash.toString('hex')}` },
      { email: `admin-${Date.now()}@test.invalid`, passwordHash: 'test' },
      { email: `staff-${Date.now()}@test.invalid`, passwordHash: 'test' },
      { email: `owner-b-${Date.now()}@test.invalid`, passwordHash: 'test' },
    ]);
    const [ownerA, adminA, staffA, ownerB] = users;
    ids.users = users.map((item) => item._id);
    await MerchantMembership.create([
      { userId: ownerA._id, merchantId: merchantA._id, role: 'owner' },
      { userId: adminA._id, merchantId: merchantA._id, role: 'admin' },
      { userId: staffA._id, merchantId: merchantA._id, role: 'staff' },
      { userId: ownerB._id, merchantId: merchantB._id, role: 'owner' },
    ]);
    for (const [key, user] of Object.entries({ ownerA, adminA, staffA, ownerB })) {
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      sessions[key] = token; csrfTokens[key] = csrf;
      const session = await AuthSession.create({ userId: user._id, tokenHash: hashToken(token), csrfHash: hashToken(csrf), expiresAt: new Date(Date.now() + 60_000) });
      ids.sessions.push(session._id);
    }

    const campaigns = await Campaign.create([
      { merchantId: merchantA._id, name: 'A campaign', budgetAmount: 10, status: 'pending' },
      { merchantId: merchantA._id, name: 'A admin campaign', budgetAmount: 10, status: 'pending' },
      { merchantId: merchantB._id, name: 'B campaign', budgetAmount: 10, status: 'pending' },
    ]);
    ids.campaigns = campaigns.map((item) => item._id);
    const customers = await Customer.create([
      { merchantId: merchantA._id, name: 'A customer' },
      { merchantId: merchantB._id, name: 'B customer' },
    ]);
    ids.customers = customers.map((item) => item._id);

    const call = (user: string | null, method: 'GET' | 'POST' | 'PATCH', url: string, merchantId?: string, body?: unknown, token?: string): Promise<InjectResponse> => {
      const headers: Record<string, string> = {};
      if (user) headers.cookie = `mga_session=${sessions[user]}; mga_csrf=${csrfTokens[user]}`;
      if (merchantId) headers['x-merchant-id'] = merchantId;
      if (method !== 'GET') {
        headers.origin = origin;
        headers['x-csrf-token'] = token ?? (user ? csrfTokens[user] : '');
      }
      return app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) } as InjectOptions);
    };

    assert.equal((await call(null, 'GET', '/api/campaigns', merchantA._id.toString())).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/campaigns', headers: { cookie: 'mga_session=invalid' } })).statusCode, 401);
    const expiredToken = randomBytes(32).toString('base64url');
    const expired = await AuthSession.create({ userId: ownerA._id, tokenHash: hashToken(expiredToken), csrfHash: hashToken('expired-csrf'), expiresAt: new Date(Date.now() - 1000) });
    ids.sessions.push(expired._id);
    assert.equal((await app.inject({ method: 'GET', url: '/api/campaigns', headers: { cookie: `mga_session=${expiredToken}` } })).statusCode, 401);

    assert.equal((await call('ownerA', 'GET', '/api/auth/session')).statusCode, 200);
    const voiceAccess = await authorizeVoiceConnection({ headers: { cookie: `mga_session=${sessions.ownerA}` } }, merchantA._id.toString(), origin, [origin]);
    assert.equal(voiceAccess.merchantId.toString(), merchantA._id.toString());
    await assert.rejects(authorizeVoiceConnection({ headers: { cookie: `mga_session=${sessions.ownerA}` } }, merchantB._id.toString(), origin, [origin]), /Merchant access unavailable/);
    const login = await call(null, 'POST', '/api/auth/login', undefined, { email: ownerA.email, password: testPassword });
    assert.equal(login.statusCode, 200);
    assert.equal(login.cookies.find((cookie) => cookie.name === 'mga_session')?.httpOnly, true);
    const aList = await call('ownerA', 'GET', '/api/campaigns', merchantA._id.toString());
    assert.equal(aList.statusCode, 200);
    assert.equal(aList.json().campaigns.length, 2);
    assert.equal((await call('ownerA', 'GET', '/api/campaigns', merchantB._id.toString())).statusCode, 403);
    assert.equal((await call('ownerA', 'GET', `/api/campaigns/${campaigns[2]._id}`, merchantA._id.toString())).statusCode, 404);
    const aCustomers = await call('ownerA', 'GET', '/api/customers?page=1', merchantA._id.toString());
    assert.equal(aCustomers.statusCode, 200);
    assert.equal(aCustomers.json().customers.length, 1);
    assert.equal((await call('ownerA', 'GET', '/api/customers?page=1', merchantB._id.toString())).statusCode, 403);
    assert.equal((await call('ownerA', 'GET', '/api/merchants/profile', merchantB._id.toString())).statusCode, 403);
    assert.equal((await call('ownerA', 'POST', '/api/ai/chat', merchantB._id.toString(), { message: 'test' })).statusCode, 403);

    assert.equal((await call('staffA', 'PATCH', `/api/campaigns/${campaigns[0]._id}/approve`, merchantA._id.toString())).statusCode, 403);
    assert.equal((await call('staffA', 'PATCH', '/api/merchants/profile', merchantA._id.toString(), { name: 'Not allowed' })).statusCode, 403);
    assert.equal((await call('ownerA', 'PATCH', `/api/campaigns/${campaigns[0]._id}/approve`, merchantA._id.toString())).statusCode, 200);
    assert.equal((await call('ownerA', 'PATCH', '/api/merchants/profile', merchantA._id.toString(), { city: 'Test City' })).statusCode, 200);
    assert.equal((await call('adminA', 'PATCH', `/api/campaigns/${campaigns[1]._id}/approve`, merchantA._id.toString())).statusCode, 200);
    const invitation = await call('adminA', 'POST', '/api/auth/invitations', merchantA._id.toString(), { email: `invite-${Date.now()}@test.invalid`, role: 'staff' });
    assert.equal(invitation.statusCode, 201);
    assert.equal(typeof invitation.json().invitation, 'string');
    const existingUserInvite = await call('adminA', 'POST', '/api/auth/invitations', merchantA._id.toString(), { email: ownerB.email, role: 'staff' });
    assert.equal(existingUserInvite.statusCode, 201);
    assert.equal((await call('ownerB', 'POST', '/api/auth/accept-invitation', merchantA._id.toString(), { invite: existingUserInvite.json().invitation })).statusCode, 200);
    assert.equal((await call('ownerB', 'GET', '/api/campaigns', merchantA._id.toString())).statusCode, 200);
    assert.equal((await call('staffA', 'POST', '/api/auth/invitations', merchantA._id.toString(), { email: 'new@test.invalid', role: 'staff' })).statusCode, 403);

    assert.equal((await app.inject({ method: 'GET', url: '/api/campaigns', headers: { cookie: `mga_session=${sessions.ownerA}`, 'x-merchant-id': merchantA._id.toString() } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/campaigns', headers: { cookie: `mga_session=${sessions.ownerA}`, 'x-merchant-id': merchantB._id.toString() } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/merchants/profile`, headers: { cookie: `mga_session=${sessions.ownerA}`, 'x-merchant-id': merchantA._id.toString(), origin, 'x-csrf-token': 'wrong' }, payload: { city: 'spoofed' } })).statusCode, 403);
    assert.equal((await call('staffA', 'POST', '/api/auth/logout')).statusCode, 200);
    assert.equal((await call('staffA', 'GET', '/api/auth/session')).statusCode, 401);
  } finally {
    await app.close();
    if (mongoose.connection.readyState === 1) {
      await Promise.all([
        CampaignResult.deleteMany({ campaignId: { $in: ids.campaigns } }),
        CampaignTarget.deleteMany({ campaignId: { $in: ids.campaigns } }),
        Campaign.deleteMany({ _id: { $in: ids.campaigns } }),
        Customer.deleteMany({ _id: { $in: ids.customers } }),
        AuthSession.deleteMany({ _id: { $in: ids.sessions } }),
        RegistrationInvite.deleteMany({ merchantId: { $in: ids.merchants } }),
        MerchantMembership.deleteMany({ userId: { $in: ids.users } }),
        AuthUser.deleteMany({ _id: { $in: ids.users } }),
        Merchant.deleteMany({ _id: { $in: ids.merchants } }),
      ]);
      await mongoose.disconnect();
    }
  }
});
