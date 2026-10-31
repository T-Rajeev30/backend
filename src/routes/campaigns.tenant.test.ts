import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { campaignRoutes } from './campaigns.js';
import { AuthSession, AuthUser, Campaign, CampaignResult, CampaignTarget, Merchant, MerchantMembership } from '../db/models.js';
import { hashToken } from '../db/helpers.js';

const mongoUri = process.env.TEST_MONGODB_URI;

test('campaign routes isolate records by merchant', { skip: !mongoUri }, async () => {
  const app = Fastify();
  let merchantIds: mongoose.Types.ObjectId[] = [];
  let campaignIds: mongoose.Types.ObjectId[] = [];
  let userId: mongoose.Types.ObjectId | undefined;
  let sessionId: mongoose.Types.ObjectId | undefined;
  let token = '';

  try {
    await mongoose.connect(mongoUri!, { dbName: 'merchant_autopilot_test' });
    app.register(campaignRoutes, { prefix: '/api/campaigns' });
    await app.ready();

    const [merchantA, merchantB] = await Merchant.create([
      { name: `Tenant test A ${Date.now()}`, businessType: 'test', dataMode: 'simulated' },
      { name: `Tenant test B ${Date.now()}`, businessType: 'test', dataMode: 'simulated' },
    ]);
    merchantIds = [merchantA._id, merchantB._id];
    const user = await AuthUser.create({ email: `tenant-${Date.now()}@test.invalid`, passwordHash: 'unused' });
    userId = user._id;
    await MerchantMembership.create({ userId: user._id, merchantId: merchantA._id, role: 'owner' });
    token = randomBytes(32).toString('base64url');
    const session = await AuthSession.create({ userId: user._id, tokenHash: hashToken(token), csrfHash: hashToken('csrf'), expiresAt: new Date(Date.now() + 60_000) });
    sessionId = session._id;
    const [campaignA, campaignB] = await Campaign.create([
      { merchantId: merchantA._id, name: 'Tenant A campaign', budgetAmount: 10, status: 'pending' },
      { merchantId: merchantB._id, name: 'Tenant B campaign', budgetAmount: 10, status: 'pending' },
    ]);
    campaignIds = [campaignA._id, campaignB._id];

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { 'x-merchant-id': merchantA._id.toString(), cookie: `mga_session=${token}` },
    });
    assert.equal(listResponse.statusCode, 200);
    const listed = listResponse.json().campaigns as Array<{ _id: string }>;
    assert.deepEqual(listed.map((campaign) => campaign._id), [campaignA._id.toString()]);

    const foreignRead = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignB._id}`,
      headers: { 'x-merchant-id': merchantA._id.toString(), cookie: `mga_session=${token}` },
    });
    assert.equal(foreignRead.statusCode, 404);

    const foreignApprove = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${campaignB._id}/approve`,
      headers: { 'x-merchant-id': merchantA._id.toString(), cookie: `mga_session=${token}`, origin: 'http://localhost:3000', 'x-csrf-token': 'csrf' },
    });
    assert.equal(foreignApprove.statusCode, 409);
    const unchanged = await Campaign.findById(campaignB._id).lean();
    assert.equal(unchanged?.status, 'pending');
  } finally {
    await app.close();
    if (mongoose.connection.readyState === 1 && (campaignIds.length || merchantIds.length)) {
      await Promise.all([
        CampaignResult.deleteMany({ campaignId: { $in: campaignIds } }),
        CampaignTarget.deleteMany({ campaignId: { $in: campaignIds } }),
        Campaign.deleteMany({ _id: { $in: campaignIds } }),
        ...(sessionId ? [AuthSession.deleteOne({ _id: sessionId })] : []),
        ...(userId ? [MerchantMembership.deleteMany({ userId }), AuthUser.deleteOne({ _id: userId })] : []),
        Merchant.deleteMany({ _id: { $in: merchantIds } }),
      ]);
    }
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
});
