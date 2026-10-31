import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SarvamAIClient } from 'sarvamai';
import { SarvamVoiceAdapter } from './voice-service.js';
import { inferVoiceTool, voiceToolSchema } from './voice-tools.js';
import { isDuplicateFinal, resolveVoiceLanguage, trimVoiceHistory, VoiceTurnCancellation } from './voice-stream.js';

test('Sarvam STT adapter surfaces provider failures', async () => {
  const fake = { speechToText: { transcribe: async () => { throw new Error('provider unavailable'); } } } as unknown as SarvamAIClient;
  const adapter = new SarvamVoiceAdapter(fake);
  await assert.rejects(adapter.transcribe(Buffer.from('audio'), 'audio/wav'), /provider unavailable/);
});

test('Sarvam TTS adapter surfaces provider failures', async () => {
  const fake = { textToSpeech: { convert: async () => { throw new Error('rate limited'); } } } as unknown as SarvamAIClient;
  const adapter = new SarvamVoiceAdapter(fake);
  await assert.rejects(adapter.speak('hello', 'en-IN'), /rate limited/);
});

test('voice tool language and intent selection is constrained to supported options', () => {
  assert.deepEqual(inferVoiceTool('What were sales today?'), { tool: 'today_sales' });
  assert.deepEqual(resolveVoiceLanguage('auto', 'kn-IN'), 'kn-IN');
  assert.deepEqual(resolveVoiceLanguage('auto', 'not-supported'), 'en-IN');
  assert.deepEqual(resolveVoiceLanguage('hi-IN', 'kn-IN'), 'hi-IN');
});

test('voice tool schema rejects campaign approval and invalid draft budgets', () => {
  assert.equal(voiceToolSchema.safeParse({ tool: 'approve_campaign', campaignId: 'abc' }).success, false);
  assert.equal(voiceToolSchema.safeParse({ tool: 'create_campaign_draft', name: 'Draft', segment: 'all', budgetAmount: -2 }).success, false);
});

test('duplicate final events are ignored, but later repeated phrases remain valid turns', () => {
  assert.equal(isDuplicateFinal('today sales', 1000, 'today sales', 2000), true);
  assert.equal(isDuplicateFinal('today sales', 1000, 'today sales', 4000), false);
});

test('barge-in aborts current response and conversation history stays bounded', () => {
  const cancellation = new VoiceTurnCancellation();
  const controller = new AbortController();
  cancellation.attach(controller);
  assert.equal(cancellation.interrupt(), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancellation.interrupt(), false);
  const history = Array.from({ length: 15 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: String(index) }));
  assert.equal(trimVoiceHistory(history).length, 12);
});

test('rapid consecutive barge-ins cancel the previous response each time', () => {
  const cancellation = new VoiceTurnCancellation();
  const first = new AbortController();
  const second = new AbortController();
  cancellation.attach(first);
  assert.equal(cancellation.interrupt(), true);
  assert.equal(first.signal.aborted, true);
  // After the first interrupt, the attached controller is cleared; attaching a
  // new turn's controller must let a later barge-in cancel the fresh response.
  cancellation.attach(second);
  assert.equal(cancellation.interrupt(), true);
  assert.equal(second.signal.aborted, true);
  assert.equal(cancellation.interrupt(), false);
});

test('language resolution rejects unsupported codes and falls back to English', () => {
  // Preferred takes priority when supported.
  assert.equal(resolveVoiceLanguage('kn-IN'), 'kn-IN');
  // Unsupported detection is ignored.
  assert.equal(resolveVoiceLanguage('auto', 'fr-FR'), 'en-IN');
  // Only the three supported languages are accepted as preferred.
  assert.equal(resolveVoiceLanguage('ta-IN'), 'en-IN');
});
