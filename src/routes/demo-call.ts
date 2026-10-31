import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Campaign, DemoCall } from '../db/models.js';
import { getRequestMerchantId } from '../db/helpers.js';
import {
  getDemoCallRecipient,
  isConsentGranted,
  maskPhone,
  DemoCallConfigError,
} from '../services/demo-call/demo-call-config.js';
import { getTelephonyProvider } from '../services/telephony/exotel-provider.js';
import { initiateDemoCall, applyDemoCallStatus, DemoCallError } from '../services/demo-call/demo-call-service.js';

function validateCampaignId(id: string) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw Object.assign(new Error('Invalid campaign ID'), { statusCode: 400 });
}

function demoCallView(demoCall: {
  status: string; providerCallId?: string; maskedPhone: string; recipientName: string;
  language: string; durationSec?: number; outcome?: string; startedAt: Date; answeredAt?: Date;
  completedAt?: Date; lastError?: string; transcript: Array<{ role: string; text: string; at: Date }>;
}, includeTranscript: boolean) {
  return {
    status: demoCall.status,
    providerCallId: demoCall.providerCallId || null,
    customerName: demoCall.recipientName,
    maskedPhone: demoCall.maskedPhone,
    language: demoCall.language,
    durationSec: demoCall.durationSec ?? null,
    outcome: demoCall.outcome || null,
    startedAt: demoCall.startedAt,
    answeredAt: demoCall.answeredAt || null,
    completedAt: demoCall.completedAt || null,
    lastError: demoCall.lastError || null,
    transcript: includeTranscript ? demoCall.transcript.map((line) => ({ role: line.role, text: line.text, at: line.at })) : undefined,
  };
}

export async function demoCallRoutes(app: FastifyInstance) {
  // Readiness probe for the UI: is the demo-call feature configured & consented?
  app.get('/demo-call/config', async (req) => {
    await getRequestMerchantId(req);
    const provider = getTelephonyProvider();
    const publicWsReady = /^wss:\/\//.test(process.env.PUBLIC_WS_URL || '');
    const publicBaseReady = /^https:\/\//.test(process.env.PUBLIC_BASE_URL || '');
    let recipientName: string | null = null;
    let maskedPhone: string | null = null;
    let recipientConfigured = false;
    try {
      const recipient = getDemoCallRecipient();
      recipientName = recipient.name;
      maskedPhone = maskPhone(recipient.phone);
      recipientConfigured = true;
    } catch { /* unconfigured — reported via flags below */ }
    return {
      recipientConfigured,
      consentGranted: isConsentGranted(),
      telephonyConfigured: Boolean(provider),
      provider: provider?.name || null,
      publicWsConfigured: publicWsReady,
      publicCallbackConfigured: publicBaseReady,
      recipientName,
      maskedPhone,
      ready: recipientConfigured && isConsentGranted() && Boolean(provider) && publicWsReady && publicBaseReady,
    };
  });

  // Create a dedicated single-customer demo-call campaign (pending approval).
  app.post<{ Body: unknown }>('/demo-call', async (req, reply) => {
    const schema = z.object({
      name: z.string().trim().min(2).max(100).default('Single Customer Demo Call'),
      language: z.enum(['en-IN', 'hi-IN']).default('en-IN'),
      discountPercent: z.coerce.number().int().min(1).max(50).default(10),
    }).strict();
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues });
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);

    let recipient;
    try { recipient = getDemoCallRecipient(); }
    catch (cause) {
      if (cause instanceof DemoCallConfigError) return reply.status(cause.statusCode).send({ error: cause.message, code: cause.code });
      throw cause;
    }

    const now = new Date();
    const campaign = await Campaign.create({
      merchantId,
      name: parsed.data.name,
      description: `Controlled single-recipient AI demo call to ${recipient.name} (${maskPhone(recipient.phone)}). Requires approval; dials exactly one consented test contact.`,
      type: 'reactivation',
      status: 'pending',
      targetSegment: 'all',
      channel: 'voice',
      isDemoCall: true,
      voiceLanguage: parsed.data.language,
      voiceMessage: `AI demo call offering ${parsed.data.discountPercent}% off the next order.`,
      discountPercent: parsed.data.discountPercent,
      startDate: now,
      endDate: new Date(now.getTime() + 86400000),
      budgetAmount: 0,
    });
    return reply.status(201).send({ campaign, message: 'Demo call campaign created and pending approval.' });
  });

  // Run exactly one outbound demo call for an approved demo campaign.
  app.post<{ Params: { id: string }; Body: unknown }>('/:id/run-demo-call', async (req, reply) => {
    validateCampaignId(req.params.id);
    const schema = z.object({ confirmRecipientEmail: z.string().trim().email().max(254) }).strict();
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'A confirmed recipient email is required to place the call.', code: 'confirmation_required' });
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);
    try {
      const result = await initiateDemoCall({
        campaignId: req.params.id,
        merchantId,
        confirmRecipientEmail: parsed.data.confirmRecipientEmail,
        publicWsUrl: process.env.PUBLIC_WS_URL,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
      });
      return reply.status(202).send({ demoCall: result, message: 'Outbound demo call initiated.' });
    } catch (cause) {
      if (cause instanceof DemoCallError || cause instanceof DemoCallConfigError) {
        return reply.status(cause.statusCode).send({ error: cause.message, code: cause.code });
      }
      throw cause;
    }
  });

  // Live status for the call dashboard (owner/admin/staff can view).
  app.get<{ Params: { id: string } }>('/:id/demo-call', async (req, reply) => {
    validateCampaignId(req.params.id);
    const merchantId = await getRequestMerchantId(req);
    const demoCall = await DemoCall.findOne({ campaignId: req.params.id, merchantId }).lean();
    if (!demoCall) return reply.status(404).send({ error: 'No demo call has been started for this campaign.' });
    return { demoCall: demoCallView(demoCall as any, true) };
  });
}

/**
 * Exotel status webhook. Not session-authenticated — Exotel presents the
 * unguessable per-call token we embedded in the StatusCallback URL. The token
 * identifies the DemoCall; an unknown token is rejected.
 */
export async function telephonyWebhookRoutes(app: FastifyInstance) {
  app.post<{ Querystring: { token?: string }; Body: Record<string, unknown> }>(
    '/exotel/status',
    { config: { rawBody: true } },
    async (req, reply) => {
      const token = (req.query.token || '').toString();
      if (!token) return reply.status(400).send({ error: 'Missing token' });
      const body = (req.body || {}) as Record<string, any>;
      // Exotel posts form-encoded CallSid/Status/… field names vary by account.
      const providerCallId = String(body.CallSid || body.Sid || body.call_sid || '');
      const status = String(body.Status || body.CallStatus || body.status || '');
      const durationRaw = body.ConversationDuration ?? body.CallDuration ?? body.Duration;
      const durationSec = durationRaw !== undefined && durationRaw !== null && `${durationRaw}` !== '' ? Number(durationRaw) : undefined;
      if (!status) return reply.status(400).send({ error: 'Missing status' });
      const updated = await applyDemoCallStatus(token, {
        providerCallId: providerCallId || undefined,
        status,
        durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
      });
      if (!updated) return reply.status(404).send({ error: 'Unknown call token' });
      return { ok: true };
    },
  );
}
