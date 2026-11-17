import type { Message } from '../domain/messaging/message';

export interface SendOptions {
  readonly signal?: AbortSignal;
}

export interface EmailProvider {
  send(message: Message, options?: SendOptions): Promise<void>;
}
