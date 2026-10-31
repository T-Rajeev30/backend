import {
  OutboundCallRequest,
  OutboundCallResult,
  TelephonyConfigError,
  TelephonyProvider,
  TelephonyProviderError,
} from './telephony-provider.js';
import { maskPhone } from '../demo-call/demo-call-config.js';

/**
 * Exotel "Connect Voice AI" (AgentStream) adapter.
 * Docs: https://developer.exotel.com/docs/agentstream/connect-voice-ai
 *
 * Initiates an outbound call that streams bidirectional audio to our media
 * WebSocket. Credentials are read from the environment and never logged.
 */

interface ExotelConfig {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  callerId: string;
  baseUrl: string;
  sampleRate: string;
}

function readConfig(): ExotelConfig | null {
  const accountSid = process.env.EXOTEL_ACCOUNT_SID?.trim();
  const apiKey = process.env.EXOTEL_API_KEY?.trim();
  const apiToken = process.env.EXOTEL_API_TOKEN?.trim();
  const callerId = process.env.EXOTEL_CALLER_ID?.trim();
  if (!accountSid || !apiKey || !apiToken || !callerId) return null;
  const baseUrl = (process.env.EXOTEL_BASE_URL?.trim() || 'https://api.in.exotel.com').replace(/\/+$/, '');
  const sampleRate = process.env.EXOTEL_STREAM_SAMPLE_RATE?.trim() || '16000';
  return { accountSid, apiKey, apiToken, callerId, baseUrl, sampleRate };
}

export class ExotelProvider implements TelephonyProvider {
  readonly name = 'exotel';

  assertConfigured(): void {
    if (!readConfig()) {
      throw new TelephonyConfigError(
        'telephony_unconfigured',
        'Exotel is not configured. Set EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN and EXOTEL_CALLER_ID in the backend environment.',
      );
    }
  }

  async initiateCall(request: OutboundCallRequest): Promise<OutboundCallResult> {
    const config = readConfig();
    if (!config) {
      throw new TelephonyConfigError(
        'telephony_unconfigured',
        'Exotel is not configured.',
      );
    }
    if (!/^wss:\/\//.test(request.streamUrl)) {
      throw new TelephonyConfigError(
        'public_ws_missing',
        'A publicly reachable wss:// stream URL is required (set PUBLIC_WS_URL). localhost is not reachable by Exotel.',
      );
    }

    const streamUrl = new URL(request.streamUrl);
    streamUrl.searchParams.set('sample-rate', config.sampleRate);

    const form = new URLSearchParams();
    form.set('From', request.to);
    form.set('CallerId', config.callerId);
    form.set('StreamUrl', streamUrl.toString());
    form.set('StreamType', 'bidirectional');
    form.set('StatusCallback', request.statusCallbackUrl);
    form.append('StatusCallbackEvents[]', 'ringing');
    form.append('StatusCallbackEvents[]', 'answered');
    form.append('StatusCallbackEvents[]', 'terminal');
    form.set('CustomField', request.correlationId);

    const endpoint = `${config.baseUrl}/v1/Accounts/${encodeURIComponent(config.accountSid)}/Calls/connect`;
    const auth = Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64');

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new TelephonyProviderError(
        timedOut ? 'provider_timeout' : 'provider_unreachable',
        timedOut
          ? 'Exotel did not respond in time. The call may or may not have started; its status must be reconciled before retrying.'
          : `Could not reach Exotel to place the call to ${maskPhone(request.to)}.`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new TelephonyProviderError(
        'provider_rejected',
        `Exotel rejected the call (HTTP ${response.status}).`,
      );
    }

    let body: any;
    try { body = JSON.parse(text); } catch {
      throw new TelephonyProviderError('provider_bad_response', 'Exotel returned an unreadable response.');
    }
    const call = body?.Call;
    const providerCallId = call?.Sid;
    if (!providerCallId) {
      throw new TelephonyProviderError('provider_bad_response', 'Exotel did not return a call id.');
    }
    return {
      providerCallId: String(providerCallId),
      status: String(call?.Status || 'queued'),
      provider: this.name,
    };
  }
}

let provider: TelephonyProvider | null = null;

/** Returns the configured telephony provider, or null if none is configured. */
export function getTelephonyProvider(): TelephonyProvider | null {
  if (!readConfig()) return null;
  if (!provider) provider = new ExotelProvider();
  return provider;
}

/** Test-only reset of the memoised provider. */
export function __resetTelephonyProvider(): void {
  provider = null;
}
