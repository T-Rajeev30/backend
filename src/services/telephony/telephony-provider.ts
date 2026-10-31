/**
 * Telephony provider boundary. Routes and the demo-call service depend on this
 * interface, not on any specific vendor SDK. All credentials stay server-side
 * and are read from environment variables inside the concrete provider.
 */

export interface OutboundCallRequest {
  /** Destination number in E.164 (the customer being called). */
  to: string;
  /** Publicly reachable wss:// URL Exotel will stream call audio to. */
  streamUrl: string;
  /** Publicly reachable https:// URL for provider status callbacks. */
  statusCallbackUrl: string;
  /** Opaque correlation id surfaced back on the media stream / callbacks. */
  correlationId: string;
}

export interface OutboundCallResult {
  providerCallId: string;
  status: string;
  provider: string;
}

export class TelephonyConfigError extends Error {
  statusCode = 422;
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class TelephonyProviderError extends Error {
  statusCode = 502;
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TelephonyProvider {
  readonly name: string;
  /** Throws TelephonyConfigError if the provider is not fully configured. */
  assertConfigured(): void;
  initiateCall(request: OutboundCallRequest): Promise<OutboundCallResult>;
}
