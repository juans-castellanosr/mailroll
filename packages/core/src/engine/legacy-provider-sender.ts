import type { SenderCapabilities } from '../contracts/sender';
import { validateSendOutcome } from '../contracts/validate-send-outcome';
import { errorSummary, recognizeSendError } from '../domain/kernel/errors';
import type { Message } from '../domain/messaging/message';
import type { ConnectionSender, SendStep } from './deliver';
import { wasCancelledBeforeAttempt } from './pre-attempt-cancellation';
import type { EmailProvider } from '../ports/email-provider';

const LEGACY_CAPABILITIES: SenderCapabilities = {
  cc: true,
  replyTo: true,
  inlineAttachments: true,
  sentCopy: 'optional',
  recipientAcceptance: 'transaction',
};

export function legacyProviderSender(provider: EmailProvider, signal: AbortSignal): ConnectionSender {
  return {
    send: async (message: Message): Promise<SendStep> => {
      const expectation = { capabilities: LEGACY_CAPABILITIES, message };

      try {
        await provider.send(message, { signal });
      } catch (error) {
        return wasCancelledBeforeAttempt(error)
          ? { outcome: 'cancelled-before-attempt' }
          : validateSendOutcome(outcomeOfError(error), expectation);
      }

      return validateSendOutcome({ outcome: 'accepted' }, expectation);
    },
  };
}

function outcomeOfError(error: unknown): unknown {
  const failure = recognizeSendError(error);

  if (failure === undefined) {
    return {
      outcome: 'unknown',
      detail: `unexpected send failure: ${errorSummary(error)}; the message may or may not have been sent`,
    };
  }

  const detail =
    failure.message.trim().length > 0 ? failure.message : `the provider reported a ${failure.category} failure`;

  switch (failure.category) {
    case 'uncertain':
      return { outcome: 'unknown', detail };
    case 'auth':
      return { outcome: 'not-accepted', reason: 'auth', scope: 'connection', detail };
    case 'transient':
    case 'throttled':
    case 'permanent':
      return {
        outcome: 'not-accepted',
        reason: failure.category,
        scope: 'message',
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        detail,
      };
  }
}
