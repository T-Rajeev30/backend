import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskPhone,
  toE164India,
  isConsentGranted,
  getDemoCallRecipient,
  DemoCallConfigError,
} from './demo-call-config.js';
import { buildOpeningLine, buildSystemPrompt, resolveDemoCallLanguage } from './demo-call-script.js';
import { normalizeProviderStatus } from './demo-call-service.js';
import { ExotelProvider, getTelephonyProvider, __resetTelephonyProvider } from '../telephony/exotel-provider.js';
import { TelephonyConfigError } from '../telephony/telephony-provider.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) { prior[key] = process.env[key]; if (vars[key] === undefined) delete process.env[key]; else process.env[key] = vars[key]; }
  const restore = () => { for (const key of Object.keys(prior)) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } };
  const result = fn();
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
}

test('maskPhone hides all but the last two digits', () => {
  assert.equal(maskPhone('+917224086640'), '+91********40');
  assert.equal(maskPhone('7224086640'), '72******40');
  assert.ok(!maskPhone('+917224086640').includes('224086'));
});

test('toE164India normalises valid Indian numbers and rejects junk', () => {
  assert.equal(toE164India('7224086640'), '+917224086640');
  assert.equal(toE164India('+917224086640'), '+917224086640');
  assert.equal(toE164India('917224086640'), '+917224086640');
  assert.equal(toE164India('12345'), null);
  assert.equal(toE164India('not-a-number'), null);
});

test('consent flag is only true when explicitly set to true', () => {
  withEnv({ DEMO_CALL_CONSENT: 'true' }, () => assert.equal(isConsentGranted(), true));
  withEnv({ DEMO_CALL_CONSENT: 'false' }, () => assert.equal(isConsentGranted(), false));
  withEnv({ DEMO_CALL_CONSENT: undefined }, () => assert.equal(isConsentGranted(), false));
  withEnv({ DEMO_CALL_CONSENT: 'yes' }, () => assert.equal(isConsentGranted(), false));
});

test('getDemoCallRecipient requires all fields and a valid number', () => {
  withEnv({ DEMO_CALL_NAME: undefined, DEMO_CALL_PHONE: undefined, DEMO_CALL_EMAIL: undefined }, () => {
    assert.throws(() => getDemoCallRecipient(), (e: unknown) => e instanceof DemoCallConfigError && e.code === 'demo_recipient_unconfigured');
  });
  withEnv({ DEMO_CALL_NAME: 'Test User', DEMO_CALL_PHONE: 'bad', DEMO_CALL_EMAIL: 'a@b.test' }, () => {
    assert.throws(() => getDemoCallRecipient(), (e: unknown) => e instanceof DemoCallConfigError && e.code === 'invalid_phone');
  });
  withEnv({ DEMO_CALL_NAME: 'Test User', DEMO_CALL_PHONE: '7224086640', DEMO_CALL_EMAIL: 'a@b.test' }, () => {
    const recipient = getDemoCallRecipient();
    assert.equal(recipient.phone, '+917224086640');
    assert.equal(recipient.name, 'Test User');
  });
});

test('opening line and system prompt address the customer and never claim an order', () => {
  const input = { recipientName: 'Rajeev Tiwari', merchantName: "Sharma Ji's Kitchen", discountPercent: 10, language: 'hi-IN' as const };
  const opening = buildOpeningLine(input);
  assert.match(opening, /Rajeev ji/);
  assert.match(opening, /Sharma Ji's Kitchen/);
  assert.match(opening, /10%/);
  const prompt = buildSystemPrompt(input);
  assert.match(prompt, /NEVER claim that an order was placed/i);
  assert.match(prompt, /end the call immediately/i);
  assert.match(prompt, /Do NOT collect personal information/i);
});

test('language resolver only accepts hi-IN or en-IN', () => {
  assert.equal(resolveDemoCallLanguage('hi-IN'), 'hi-IN');
  assert.equal(resolveDemoCallLanguage('en-IN'), 'en-IN');
  assert.equal(resolveDemoCallLanguage('kn-IN'), 'en-IN');
  assert.equal(resolveDemoCallLanguage(undefined), 'en-IN');
});

test('provider status normalisation maps provider states to call states', () => {
  assert.equal(normalizeProviderStatus('in-progress'), 'in-progress');
  assert.equal(normalizeProviderStatus('answered'), 'in-progress');
  assert.equal(normalizeProviderStatus('completed'), 'completed');
  assert.equal(normalizeProviderStatus('no-answer'), 'no-answer');
  assert.equal(normalizeProviderStatus('busy'), 'busy');
  assert.equal(normalizeProviderStatus('failed'), 'failed');
  assert.equal(normalizeProviderStatus('canceled'), 'rejected');
  assert.equal(normalizeProviderStatus('ringing'), 'ringing');
});

test('getTelephonyProvider is null without credentials and set with them', async () => {
  __resetTelephonyProvider();
  await withEnv({ EXOTEL_ACCOUNT_SID: undefined, EXOTEL_API_KEY: undefined, EXOTEL_API_TOKEN: undefined, EXOTEL_CALLER_ID: undefined }, () => {
    assert.equal(getTelephonyProvider(), null);
  });
  await withEnv({ EXOTEL_ACCOUNT_SID: 'AC', EXOTEL_API_KEY: 'k', EXOTEL_API_TOKEN: 't', EXOTEL_CALLER_ID: '080000' }, () => {
    const provider = getTelephonyProvider();
    assert.ok(provider);
    assert.equal(provider!.name, 'exotel');
  });
  __resetTelephonyProvider();
});

test('ExotelProvider.assertConfigured throws a typed config error when unconfigured', async () => {
  await withEnv({ EXOTEL_ACCOUNT_SID: undefined, EXOTEL_API_KEY: undefined, EXOTEL_API_TOKEN: undefined, EXOTEL_CALLER_ID: undefined }, () => {
    const provider = new ExotelProvider();
    assert.throws(() => provider.assertConfigured(), (e: unknown) => e instanceof TelephonyConfigError && e.code === 'telephony_unconfigured');
  });
});

test('ExotelProvider rejects a non-wss stream URL before dialing', async () => {
  await withEnv({ EXOTEL_ACCOUNT_SID: 'AC', EXOTEL_API_KEY: 'k', EXOTEL_API_TOKEN: 't', EXOTEL_CALLER_ID: '080000' }, async () => {
    const provider = new ExotelProvider();
    await assert.rejects(
      provider.initiateCall({ to: '+917224086640', streamUrl: 'http://localhost/x', statusCallbackUrl: 'https://x/cb', correlationId: 'abc' }),
      (e: unknown) => e instanceof TelephonyConfigError && e.code === 'public_ws_missing',
    );
  });
});
