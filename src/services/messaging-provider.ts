/**
 * A share-link adapter is a merchant-initiated handoff, not automated delivery.
 * A future campaign sender can implement this boundary once credentials and
 * customer consent are available.
 */
export interface MessageShareProvider {
  readonly name: string;
  createShareUrl(message: string): string;
}

export class WhatsAppClickToChatProvider implements MessageShareProvider {
  readonly name = 'whatsapp_click_to_chat';

  createShareUrl(message: string): string {
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }
}

export const messageShareProvider: MessageShareProvider = new WhatsAppClickToChatProvider();
