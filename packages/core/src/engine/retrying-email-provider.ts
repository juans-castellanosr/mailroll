import { SendError, recognizeSendError } from '../domain/kernel/errors';
import type { Message } from '../domain/messaging/message';
import type { Pacing } from '../domain/catalog/pacing';
import { cancelBeforeAttempt } from './pre-attempt-cancellation';
import { freshRetryState, nextRetry } from './retry-budget';
import type { EmailProvider, SendOptions } from '../ports/email-provider';
import type { Sleeper } from '../ports/sleeper';

export class RetryingEmailProvider implements EmailProvider {
  constructor(
    private readonly inner: EmailProvider,
    private readonly pacing: Pacing,
    private readonly sleeper: Sleeper,
    private readonly random: () => number = Math.random,
  ) {}

  async send(message: Message, options: SendOptions = {}): Promise<void> {
    const { signal } = options;
    const state = freshRetryState();

    for (;;) {
      if (signal?.aborted === true) {
        throw cancelBeforeAttempt('run stopped before this message was sent');
      }

      try {
        await this.inner.send(message, options);

        return;
      } catch (error) {
        const failure = recognizeSendError(error);

        if (failure === undefined || (failure.category !== 'transient' && failure.category !== 'throttled')) {
          throw error;
        }

        const decision = nextRetry(
          {
            reason: failure.category,
            detail: failure.message,
            ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          },
          state,
          this.pacing,
          this.random,
        );

        if ('exhausted' in decision) {
          throw failure.category === 'throttled'
            ? new SendError(decision.exhausted, 'throttled', { cause: error })
            : error;
        }

        await this.sleeper.sleep(decision.wait, signal);
      }
    }
  }
}
