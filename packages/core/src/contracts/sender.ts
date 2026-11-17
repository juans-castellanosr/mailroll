import type { EmailAddress } from '../domain/addressing/email-address';
import type { Message } from '../domain/messaging/message';
import type { Logger } from '../ports/logger';

export const SENDER_CONTRACT = 'sender/0';

export type RecipientAcceptance = 'per-recipient' | 'transaction';

export type SentCopy = 'never' | 'optional' | 'always';

export interface SenderCapabilities {
  readonly cc: boolean;
  readonly replyTo: boolean;
  readonly inlineAttachments: boolean;
  readonly maxMessageBytes?: number;
  readonly maxCc?: number;
  readonly sentCopy: SentCopy;
  readonly recipientAcceptance: RecipientAcceptance;
}

export interface SenderInteraction {
  announce(message: string): void;
}

export interface SenderContext<Settings> {
  readonly connectionId: string;
  readonly from: EmailAddress;
  readonly fromName?: string;
  readonly settings: Settings;
  readonly secrets: Readonly<Record<string, string>>;
  readonly stateDirectory: string;
  readonly stateKey: string;
  readonly interaction: SenderInteraction;
  readonly interactive: boolean;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

export interface SendAttempt {
  readonly attemptId: string;
  readonly call: number;
}

export interface SendPreferences {
  readonly keepSentCopy: boolean;
}

export type NotAcceptedReason = 'transient' | 'throttled' | 'auth' | 'permanent';

export type FailureScope = 'message' | 'connection';

export interface AcceptedOutcome {
  readonly outcome: 'accepted';
  readonly providerMessageId?: string;
  readonly ccRejected?: readonly string[];
}

export interface NotAcceptedOutcome {
  readonly outcome: 'not-accepted';
  readonly reason: NotAcceptedReason;
  readonly scope: FailureScope;
  readonly retryAfterMs?: number;
  readonly detail: string;
}

export interface UnknownOutcome {
  readonly outcome: 'unknown';
  readonly detail: string;
}

export type SendOutcome = AcceptedOutcome | NotAcceptedOutcome | UnknownOutcome;

export interface PreparedSender {
  send(message: Message, attempt: SendAttempt, preferences: SendPreferences): Promise<SendOutcome>;
  close(): Promise<void>;
}

export interface SenderRole<Settings> {
  readonly contract: typeof SENDER_CONTRACT;
  readonly capabilities: SenderCapabilities;
  prepare(context: SenderContext<Settings>): Promise<PreparedSender>;
}
