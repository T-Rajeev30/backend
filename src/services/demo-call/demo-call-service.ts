import { randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { Campaign, DemoCall } from '../../db/models.js';
import {
  DemoCallConfigError,
  getDemoCallRecipient,
  isConsentGranted,
  maskPhone,
} from './demo-call-config.js';
import { resolveDemoCallLanguage } from './demo-call-script.js';
import { getTelephonyProvider } from '../telephony/exotel-provider.js';
import type { TelephonyProvider } from '../telephony/telephony-provider.js';

export class DemoCallError extends Error {
  statusCode: number;
  code: string;
  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface InitiateDemoCallInput {
  campaignId: string;
  merchantId: Types.ObjectId;
  /** Must equal the configured DEMO_CALL_EMAIL — proves the caller intends the configured recipient. */
  confirmRecipientEmail: string;
  publicWsUrl?: string;
  publicBaseUrl?: string;
  /** Injectable for tests; defaults to the configured Exotel provider. */
  provider?: TelephonyProvider | null;
}

function requirePublicEndpoints(publicWsUrl?: string, publicBaseUrl?: string) {
  if (!publicWsUrl || !/^wss:\/\//.test(publicWsUrl)) {
    throw new DemoCallError(
      'public_ws_missing',
      'A publicly reachable wss:// media URL is required (set PUBLIC_WS_URL). Exotel cannot reach localhost.',
      422,
    );
  }
  if (!publicBaseUrl || !/^https:\/\//.test(publicBaseUrl)) {
    throw new DemoCallError(
      'public_base_missing',
      'A publicly reachable https:// base URL is required for status callbacks (set PUBLIC_BASE_URL).',
      422,
    );
  }
}

/**
 * Validates every safety gate and places exactly one outbound demo call.
 * Never falls back to simulation; on any failure it throws a typed error.
 */
export async function initiateDemoCall(input: InitiateDemoCallInput) {
  // 1. Configured recipient + explicit consent.
  const recipient = getDemoCallRecipient(); // throws DemoCallConfigError
  if (!isConsentGranted()) {
    throw new DemoCallError(
      'consent_missing',
      'The test recipient has not granted explicit calling consent (set DEMO_CALL_CONSENT=true after confirming opt-in).',
      422,
    );
  }

  // 2. Recipient match — the caller must confirm the configured recipient.
  if ((input.confirmRecipientEmail || '').trim().toLowerCase() !== recipient.email.toLowerCase()) {
    throw new DemoCallError(
      'recipient_mismatch',
      'The confirmed recipient does not match the configured demo recipient.',
      422,
    );
  }

  // 3. Telephony provider configured.
  const provider = input.provider !== undefined ? input.provider : getTelephonyProvider();
  if (!provider) {
    throw new DemoCallError(
      'telephony_unconfigured',
      'No telephony provider is configured. Set the Exotel credentials in the backend environment.',
      422,
    );
  }
  provider.assertConfigured();

  // 4. Public endpoints reachable by the provider.
  requirePublicEndpoints(input.publicWsUrl, input.publicBaseUrl);

  // 5. Atomic claim: only an approved demo campaign can be claimed, exactly once.
  const claimed = await Campaign.findOneAndUpdate(
    { _id: input.campaignId, merchantId: input.merchantId, isDemoCall: true, status: 'approved' },
    { status: 'running' },
    { new: true },
  ).lean();

  if (!claimed) {
    // Produce a precise reason without mutating anything further.
    const existing = await Campaign.findOne({ _id: input.campaignId, merchantId: input.merchantId })
      .select('status isDemoCall').lean();
    if (!existing) throw new DemoCallError('campaign_not_found', 'Campaign not found.', 404);
    if (!existing.isDemoCall) throw new DemoCallError('not_demo_campaign', 'This campaign is not a single-customer demo call campaign.', 400);
    if (existing.status === 'pending') throw new DemoCallError('not_approved', 'The campaign must be approved before placing the demo call.', 409);
    if (existing.status === 'rejected') throw new DemoCallError('rejected', 'A rejected campaign cannot place a call.', 409);
    // running / completed → already claimed.
    throw new DemoCallError('already_claimed', 'A demo call has already been started for this campaign.', 409);
  }

  const language = resolveDemoCallLanguage(claimed.voiceLanguage);
  const correlationId = randomBytes(24).toString('base64url');

  // 6. One DemoCall record per campaign (unique index is the duplicate guard).
  let demoCall;
  try {
    demoCall = await DemoCall.create({
      campaignId: claimed._id,
      merchantId: input.merchantId,
      provider: provider.name,
      correlationId,
      status: 'initiating',
      maskedPhone: maskPhone(recipient.phone),
      recipientName: recipient.name,
      language,
      consentConfirmedAt: new Date(),
    });
  } catch (cause: any) {
    // Revert the claim so the campaign is not stuck if the record clashed.
    await Campaign.updateOne({ _id: claimed._id, merchantId: input.merchantId, status: 'running' }, { status: 'approved' });
    if (cause?.code === 11000) {
      throw new DemoCallError('duplicate_call', 'A demo call already exists for this campaign.', 409);
    }
    throw cause;
  }

  // 7. Build provider-facing URLs carrying the unguessable correlation token.
  const streamUrl = `${input.publicWsUrl!.replace(/\/+$/, '')}/api/telephony/exotel/media?token=${correlationId}`;
  const statusCallbackUrl = `${input.publicBaseUrl!.replace(/\/+$/, '')}/api/telephony/exotel/status?token=${correlationId}`;

  // 8. Place exactly one call.
  try {
    const result = await provider.initiateCall({
      to: recipient.phone,
      streamUrl,
      statusCallbackUrl,
      correlationId,
    });
    demoCall.providerCallId = result.providerCallId;
    demoCall.status = normalizeProviderStatus(result.status);
    await demoCall.save();
    return {
      campaignId: String(claimed._id),
      providerCallId: result.providerCallId,
      provider: result.provider,
      status: demoCall.status,
      recipientName: recipient.name,
      maskedPhone: demoCall.maskedPhone,
      language,
    };
  } catch (cause: any) {
    const code = cause?.code || 'provider_error';
    // Timeout is special: the call may actually be dialing. Do NOT delete or
    // auto-retry — leave the record for reconciliation via the webhook.
    if (code === 'provider_timeout') {
      demoCall.status = 'initiating';
      demoCall.lastError = cause.message;
      await demoCall.save();
      throw new DemoCallError(
        'provider_timeout',
        cause.message || 'The provider timed out; reconcile the call status before trying again.',
        504,
      );
    }
    // Hard failure before the call started: release the claim and remove the
    // record so a corrected manual retry is possible (no automatic retry).
    demoCall.status = 'failed';
    demoCall.lastError = cause?.message;
    await demoCall.save();
    await Campaign.updateOne({ _id: claimed._id, merchantId: input.merchantId, status: 'running' }, { status: 'approved' });
    throw new DemoCallError(code, cause?.message || 'The call could not be placed.', cause?.statusCode || 502);
  }
}

export function normalizeProviderStatus(raw: string): import('../../db/models.js').DemoCallStatus {
  const value = (raw || '').toLowerCase();
  if (value === 'queued' || value === 'initiating') return 'queued';
  if (value === 'ringing') return 'ringing';
  if (value === 'in-progress' || value === 'answered' || value === 'in_progress') return 'in-progress';
  if (value === 'completed') return 'completed';
  if (value === 'busy') return 'busy';
  if (value === 'no-answer' || value === 'no_answer') return 'no-answer';
  if (value === 'failed') return 'failed';
  if (value === 'rejected' || value === 'canceled' || value === 'cancelled') return 'rejected';
  return 'queued';
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'busy', 'no-answer', 'rejected']);

/**
 * Applies a provider status callback to the DemoCall, authenticated by the
 * per-call correlation token. Never invents transitions: only maps the
 * provider-reported status. Returns the updated record, or null if the token
 * is unknown.
 */
export async function applyDemoCallStatus(correlationId: string, params: {
  providerCallId?: string;
  status: string;
  durationSec?: number;
  streamSid?: string;
}) {
  const demoCall = await DemoCall.findOne({ correlationId });
  if (!demoCall) return null;
  // If a providerCallId is known on both sides, they must match.
  if (demoCall.providerCallId && params.providerCallId && demoCall.providerCallId !== params.providerCallId) {
    return null;
  }
  const next = normalizeProviderStatus(params.status);
  demoCall.status = next;
  if (params.providerCallId && !demoCall.providerCallId) demoCall.providerCallId = params.providerCallId;
  if (params.streamSid) demoCall.streamSid = params.streamSid;
  if (next === 'in-progress' && !demoCall.answeredAt) demoCall.answeredAt = new Date();
  if (TERMINAL.has(next)) {
    demoCall.completedAt = demoCall.completedAt || new Date();
    if (typeof params.durationSec === 'number') demoCall.durationSec = params.durationSec;
    demoCall.outcome = next;
  }
  await demoCall.save();

  // Reflect terminal state onto the campaign (running -> completed).
  if (TERMINAL.has(next)) {
    await Campaign.updateOne(
      { _id: demoCall.campaignId, status: 'running' },
      { status: 'completed', completedAt: new Date() },
    );
  }
  return demoCall;
}

export { DemoCallConfigError };
