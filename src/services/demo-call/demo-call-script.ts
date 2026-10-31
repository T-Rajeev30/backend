/**
 * Configurable demo-call conversation. The opening line and the AI system
 * prompt are built here (optionally overridden by env) rather than hardcoded
 * into the telephony adapter, so the call behaviour can be changed without
 * touching provider code.
 */

export type DemoCallLanguage = 'en-IN' | 'hi-IN';

export interface DemoCallScriptInput {
  recipientName: string;
  merchantName: string;
  discountPercent: number;
  language: DemoCallLanguage;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

export function buildOpeningLine(input: DemoCallScriptInput): string {
  const override = process.env.DEMO_CALL_OPENING?.trim();
  if (override) return override;
  const name = firstName(input.recipientName);
  if (input.language === 'hi-IN') {
    return `Namaste ${name} ji! Main ${input.merchantName} ke AI assistant ki taraf se baat kar raha hoon. Aapke liye ek special offer hai. Aaj aapko apne next order par ${input.discountPercent}% discount mil sakta hai. Kya aap is offer ke baare mein aur jaana chahenge?`;
  }
  return `Hello ${name} ji! I'm calling as the AI assistant for ${input.merchantName}. We have a special offer for you — ${input.discountPercent}% off your next order. Would you like to hear more about it?`;
}

export function buildSystemPrompt(input: DemoCallScriptInput): string {
  const override = process.env.DEMO_CALL_SYSTEM_PROMPT?.trim();
  if (override) return override;
  const name = firstName(input.recipientName);
  const langName = input.language === 'hi-IN' ? 'Hindi' : 'English';
  return [
    `You are an AI assistant making a brief, polite outbound phone call on behalf of ${input.merchantName}, a restaurant.`,
    `Speak naturally and concisely in ${langName}. Address the customer respectfully as "${name} ji".`,
    `Purpose of the call: tell ${name} ji about a demo offer of ${input.discountPercent}% off their next order, and ask if they are interested.`,
    `Rules you must follow strictly:`,
    `- Introduce yourself as an AI assistant calling on behalf of ${input.merchantName}.`,
    `- Keep turns short; this is a phone conversation, not a chat.`,
    `- Answer only simple questions about this ${input.discountPercent}% discount offer.`,
    `- If the customer declines or is not interested, thank them politely and end the call immediately. Do not persuade further.`,
    `- If the customer asks to end the call or says stop, end immediately and politely.`,
    `- Do NOT collect personal information (no address, no card, no OTP, no payment details).`,
    `- NEVER claim that an order was placed or that the offer was redeemed. This is only an informational demo offer.`,
    `- Do not make promises about delivery, pricing beyond the stated discount, or availability.`,
    `- If you do not understand, ask the customer to repeat, once.`,
  ].join('\n');
}

export function resolveDemoCallLanguage(raw: string | undefined): DemoCallLanguage {
  return raw === 'hi-IN' ? 'hi-IN' : 'en-IN';
}
