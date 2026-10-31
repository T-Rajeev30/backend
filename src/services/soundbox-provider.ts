import type { Types } from 'mongoose';

export interface SoundboxAnnouncement {
  audioBase64: string;
  mimeType: 'audio/wav';
  language: 'en-IN' | 'hi-IN' | 'kn-IN';
}

/**
 * Integration boundary for an authorized Soundbox provider.
 * No Paytm device API is configured in this prototype.
 */
export interface SoundboxProvider {
  announce(merchantId: Types.ObjectId, announcement: SoundboxAnnouncement): Promise<void>;
}

export function getSoundboxProvider(): SoundboxProvider | null {
  return null;
}
