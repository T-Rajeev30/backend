import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Types } from 'mongoose';
import { initiateDemoCall, applyDemoCallStatus, DemoCallError } from './demo-call-service.js';
import type { TelephonyProvider, OutboundCallRequest } from '../telephony/telephony-provider.js';
import { TelephonyProviderError } from '../telephony/telephony-provider.js';

const mongoUri = process.env.TEST_MONGODB_URI;

const GOOD_ENV = {
  DEMO_CALL_NAME: 'Rajeev Tiwari',
  DEMO_CALL_PHONE: '7224086640',
  DEMO_CALL_EMAIL: 'rajeevtiwari30305@gmail.com',
  DEMO_CALL_CONSENT: 'true',
};
const PUBLIC = { publicWsUrl: 'wss://public.example/ws', publicBaseUrl: 'https://public.example' };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
function snapshot(keys: string[]) {
  const prior: Record<string, string | undefined> = {};
  for (const k of keys) prior[k] = process.env[k];
  return () => setEnv(prior);
}

class FakeProvider implements TelephonyProvider {
  readonly name = 'fake';
  calls: OutboundCallRequest[] = [];
  mode: 'ok' | 'reject' | 'timeout' = 'ok';
  assertConfigured(): void {}
  async initiateCall(request: OutboundCallRequest) {
    this.calls.push(request);
    if (this.mode === 'reject') throw new TelephonyProviderError('provider_rejected', 'Provider rejected the call');
    if (this.mode === 'timeout') throw new TelephonyProviderError('provider_timeout', 'Provider timed out');
    return { providerCallId: `CA-${this.calls.length}`, status: 'queued', provider: this.name };
  }
}

// ── Gate tests: these fail before any DB access, so they need no database. ──

test('demo call requires explicit consent', async () => {
  const restore = snapshot(Object.keys(GOOD_ENV));
  setEnv({ ...GOOD_ENV, DEMO_CALL_CONSENT: 'false' });
  try {
    await assert.rejects(
      initiateDemoCall({ campaignId: new Types.ObjectId().toString(), merchantId: new Types.ObjectId(), confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: new FakeProvider(), ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'consent_missing',
    );
  } finally { restore(); }
});

test('demo call rejects a recipient email that does not match the configured contact', async () => {
  const restore = snapshot(Object.keys(GOOD_ENV));
  setEnv(GOOD_ENV);
  try {
    await assert.rejects(
      initiateDemoCall({ campaignId: new Types.ObjectId().toString(), merchantId: new Types.ObjectId(), confirmRecipientEmail: 'someone-else@example.test', provider: new FakeProvider(), ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'recipient_mismatch',
    );
  } finally { restore(); }
});

test('demo call fails clearly when no telephony provider is configured', async () => {
  const restore = snapshot(Object.keys(GOOD_ENV));
  setEnv(GOOD_ENV);
  try {
    await assert.rejects(
      initiateDemoCall({ campaignId: new Types.ObjectId().toString(), merchantId: new Types.ObjectId(), confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: null, ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'telephony_unconfigured',
    );
  } finally { restore(); }
});

test('demo call requires a public wss media URL and https callback URL', async () => {
  const restore = snapshot(Object.keys(GOOD_ENV));
  setEnv(GOOD_ENV);
  try {
    await assert.rejects(
      initiateDemoCall({ campaignId: new Types.ObjectId().toString(), merchantId: new Types.ObjectId(), confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: new FakeProvider(), publicWsUrl: 'http://localhost/ws', publicBaseUrl: 'https://x' }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'public_ws_missing',
    );
    await assert.rejects(
      initiateDemoCall({ campaignId: new Types.ObjectId().toString(), merchantId: new Types.ObjectId(), confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: new FakeProvider(), publicWsUrl: 'wss://x/ws', publicBaseUrl: 'http://localhost' }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'public_base_missing',
    );
  } finally { restore(); }
});

// ── Full-flow tests: require a disposable MongoDB. ──

test('demo call lifecycle: one call, duplicate protection, webhook, provider failure', { skip: !mongoUri }, async () => {
  const restore = snapshot(Object.keys(GOOD_ENV));
  setEnv(GOOD_ENV);
  const { Campaign, DemoCall, Merchant } = await import('../../db/models.js');
  const ids: Types.ObjectId[] = [];
  try {
    await mongoose.connect(mongoUri!, { dbName: 'merchant_autopilot_test' });
    const merchant = await Merchant.create({ name: 'Demo Call Test', businessType: 'restaurant', dataMode: 'simulated' });
    ids.push(merchant._id);

    // Approved demo campaign.
    const campaign = await Campaign.create({
      merchantId: merchant._id, name: 'Demo', description: 'demo', type: 'reactivation',
      status: 'approved', targetSegment: 'all', channel: 'voice', isDemoCall: true,
      voiceLanguage: 'hi-IN', discountPercent: 10, startDate: new Date(), endDate: new Date(Date.now() + 86400000), budgetAmount: 0,
    });

    // 1. Happy path places exactly one call.
    const provider = new FakeProvider();
    const result = await initiateDemoCall({
      campaignId: campaign._id.toString(), merchantId: merchant._id,
      confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider, ...PUBLIC,
    });
    assert.equal(provider.calls.length, 1);
    assert.equal(result.providerCallId, 'CA-1');
    assert.match(result.maskedPhone, /\*/);
    assert.ok(!result.maskedPhone.includes('224086'));
    const afterClaim = await Campaign.findById(campaign._id).lean();
    assert.equal(afterClaim?.status, 'running');

    // 2. Second run is rejected — no duplicate call.
    await assert.rejects(
      initiateDemoCall({ campaignId: campaign._id.toString(), merchantId: merchant._id, confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider, ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && (e.code === 'already_claimed' || e.code === 'duplicate_call'),
    );
    assert.equal(provider.calls.length, 1);

    // 3. Webhook transitions to completed and completes the campaign.
    const demoCall = await DemoCall.findOne({ campaignId: campaign._id });
    assert.ok(demoCall);
    const updated = await applyDemoCallStatus(demoCall!.correlationId, { providerCallId: 'CA-1', status: 'completed', durationSec: 42 });
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.durationSec, 42);
    const completedCampaign = await Campaign.findById(campaign._id).lean();
    assert.equal(completedCampaign?.status, 'completed');

    // 4. Provider rejection reverts the claim so the campaign is not stuck.
    const campaign2 = await Campaign.create({
      merchantId: merchant._id, name: 'Demo2', description: 'demo', type: 'reactivation',
      status: 'approved', targetSegment: 'all', channel: 'voice', isDemoCall: true,
      voiceLanguage: 'en-IN', discountPercent: 10, startDate: new Date(), endDate: new Date(Date.now() + 86400000), budgetAmount: 0,
    });
    const rejecting = new FakeProvider(); rejecting.mode = 'reject';
    await assert.rejects(
      initiateDemoCall({ campaignId: campaign2._id.toString(), merchantId: merchant._id, confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: rejecting, ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'provider_rejected',
    );
    const revert = await Campaign.findById(campaign2._id).lean();
    assert.equal(revert?.status, 'approved'); // claim released for a corrected manual retry

    // 5. A non-approved campaign cannot be run.
    const pending = await Campaign.create({
      merchantId: merchant._id, name: 'Pending', description: 'demo', type: 'reactivation',
      status: 'pending', targetSegment: 'all', channel: 'voice', isDemoCall: true,
      voiceLanguage: 'en-IN', discountPercent: 10, startDate: new Date(), endDate: new Date(Date.now() + 86400000), budgetAmount: 0,
    });
    await assert.rejects(
      initiateDemoCall({ campaignId: pending._id.toString(), merchantId: merchant._id, confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: new FakeProvider(), ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'not_approved',
    );

    // 6. A non-demo campaign is rejected.
    const standard = await Campaign.create({
      merchantId: merchant._id, name: 'Standard', description: 'x', type: 'discount',
      status: 'approved', targetSegment: 'all', channel: 'message', isDemoCall: false,
      startDate: new Date(), endDate: new Date(Date.now() + 86400000), budgetAmount: 100,
    });
    await assert.rejects(
      initiateDemoCall({ campaignId: standard._id.toString(), merchantId: merchant._id, confirmRecipientEmail: GOOD_ENV.DEMO_CALL_EMAIL, provider: new FakeProvider(), ...PUBLIC }),
      (e: unknown) => e instanceof DemoCallError && e.code === 'not_demo_campaign',
    );

    await DemoCall.deleteMany({ merchantId: merchant._id });
    await Campaign.deleteMany({ merchantId: merchant._id });
  } finally {
    if (mongoose.connection.readyState === 1) {
      const { Merchant } = await import('../../db/models.js');
      await Merchant.deleteMany({ _id: { $in: ids } });
      await mongoose.disconnect();
    }
    restore();
  }
});
