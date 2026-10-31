/**
 * Controlled single-recipient demo call configuration.
 *
 * The test contact and its explicit calling consent are supplied only through
 * backend environment variables — never hardcoded, never a production default.
 * The full phone number is never logged; use maskPhone() for any logging or
 * API response.
 */

export interface DemoCallRecipient {
  name: string;
  /** E.164, e.g. +917224086640 — kept server-side, never logged in full. */
  phone: string;
  email: string;
}

export class DemoCallConfigError extends Error {
  statusCode = 422;
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Mask all but the last 2 digits: +917224086640 -> +91*******40 */
export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return '****';
  const keepPrefix = trimmed.startsWith('+') ? 3 : 2;
  const last = trimmed.slice(-2);
  const masked = '*'.repeat(Math.max(0, trimmed.length - keepPrefix - 2));
  return `${trimmed.slice(0, keepPrefix)}${masked}${last}`;
}

/** Normalise an Indian number to E.164 (+91…). Returns null if not valid. */
export function toE164India(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+91\d{10}$/.test(digits)) return digits;
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+91${digits}`;
  return null;
}

export function isConsentGranted(): boolean {
  return (process.env.DEMO_CALL_CONSENT || '').trim().toLowerCase() === 'true';
}

/**
 * Returns the configured demo recipient, or throws a DemoCallConfigError with a
 * specific code when the configuration is incomplete or invalid. Does not check
 * consent — call isConsentGranted() separately so the caller can report a
 * distinct "consent missing" error.
 */
export function getDemoCallRecipient(): DemoCallRecipient {
  const name = (process.env.DEMO_CALL_NAME || '').trim();
  const rawPhone = (process.env.DEMO_CALL_PHONE || '').trim();
  const email = (process.env.DEMO_CALL_EMAIL || '').trim();

  if (!name || !rawPhone || !email) {
    throw new DemoCallConfigError(
      'demo_recipient_unconfigured',
      'Demo call recipient is not configured. Set DEMO_CALL_NAME, DEMO_CALL_PHONE and DEMO_CALL_EMAIL in the backend environment.',
    );
  }
  const phone = toE164India(rawPhone);
  if (!phone) {
    throw new DemoCallConfigError(
      'invalid_phone',
      'DEMO_CALL_PHONE is not a valid Indian phone number.',
    );
  }
  return { name, phone, email };
}
