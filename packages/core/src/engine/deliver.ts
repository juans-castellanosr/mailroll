import { dispositionOf } from '../contracts/outcome-disposition';
import type { NotAcceptedReason, SendAttempt, SendPreferences } from '../contracts/sender';
import type { ValidatedNotAcceptedOutcome, ValidatedSendOutcome } from '../contracts/validate-send-outcome';
import type { EmailAddress } from '../domain/addressing/email-address';
import type { Pacing } from '../domain/catalog/pacing';
import type { Message } from '../domain/messaging/message';
import { optionalField } from '../domain/kernel/optional-field';
import { freshRetryState, nextRetry } from './retry-budget';
import type { Sleeper } from '../ports/sleeper';

export type SendStep = ValidatedSendOutcome | { readonly outcome: 'cancelled-before-attempt' };

export interface ConnectionSender {
  send(message: Message, attempt: SendAttempt, preferences: SendPreferences): Promise<SendStep>;
}

export type RetryPolicy = { readonly kind: 'core'; readonly pacing: Pacing } | { readonly kind: 'inside-provider' };

export type Delivery =
  | { readonly kind: 'sent'; readonly providerMessageId?: string; readonly ccRejected?: readonly EmailAddress[] }
  | { readonly kind: 'failed'; readonly category: Exclude<NotAcceptedReason, 'auth'>; readonly message: string }
  | { readonly kind: 'uncertain'; readonly message: string }
  | { readonly kind: 'stop-connection'; readonly auth: boolean; readonly message: string }
  | { readonly kind: 'cancelled'; readonly waited: boolean };

export interface DeliveryOptions {
  readonly attemptId: string;
  readonly preferences: SendPreferences;
  readonly retry: RetryPolicy;
  readonly sleeper: Sleeper;
  readonly signal: AbortSignal;
  readonly random: () => number;
}

export async function deliver(sender: ConnectionSender, message: Message, options: DeliveryOptions): Promise<Delivery> {
  const state = freshRetryState();

  for (let call = 1; ; call += 1) {
    if (options.signal.aborted) {
      return { kind: 'cancelled', waited: call > 1 };
    }

    const step = await sender.send(message, { attemptId: options.attemptId, call }, options.preferences);

    if (step.outcome === 'cancelled-before-attempt') {
      return { kind: 'cancelled', waited: true };
    }

    if (step.outcome === 'accepted') {
      return {
        kind: 'sent',
        ...optionalField('providerMessageId', step.providerMessageId),
        ...optionalField('ccRejected', step.ccRejected),
      };
    }

    if (step.outcome === 'unknown') {
      return { kind: 'uncertain', message: step.detail };
    }

    const disposition = dispositionOf(step);

    if (disposition.kind !== 'retry') {
      return settled(step, step.detail, disposition.kind === 'record-failed');
    }

    const decision =
      options.retry.kind === 'core' && (step.reason === 'transient' || step.reason === 'throttled')
        ? nextRetry(
            {
              reason: step.reason,
              detail: step.detail,
              ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
            },
            state,
            options.retry.pacing,
            options.random,
          )
        : { exhausted: step.detail };

    if ('exhausted' in decision) {
      return settled(step, decision.exhausted, disposition.whenExhausted === 'record-failed');
    }

    await options.sleeper.sleep(decision.wait, options.signal);
  }
}

function settled(step: ValidatedNotAcceptedOutcome, message: string, recordFailure: boolean): Delivery {
  return recordFailure && step.reason !== 'auth'
    ? { kind: 'failed', category: step.reason, message }
    : { kind: 'stop-connection', auth: step.reason === 'auth', message };
}
