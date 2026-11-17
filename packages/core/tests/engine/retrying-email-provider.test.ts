import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import { SendCancelledError, SendError } from '../../src/domain/kernel/errors';
import type { Message } from '../../src/domain/messaging/message';
import type { Pacing } from '../../src/domain/catalog/pacing';
import type { EmailProvider } from '../../src/ports/email-provider';
import type { Sleeper } from '../../src/ports/sleeper';
import { RetryingEmailProvider } from '../../src/engine/retrying-email-provider';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

const MESSAGE: Message = { to: addr('a@b.co'), subject: 's', html: '<p>x</p>' };
const PACING: Pacing = {
  delayBetweenSendsMs: 0,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
  maxRetryAfterMs: 900_000,
  maxThrottleWaitMs: 1_000_000,
};

class RecordingSleeper implements Sleeper {
  readonly delays: number[] = [];
  async sleep(ms: number): Promise<void> {
    this.delays.push(ms);
    await Promise.resolve();
  }
}

class FlakyProvider implements EmailProvider {
  calls = 0;
  constructor(
    private readonly failures: number,
    private readonly error: unknown,
  ) {}

  async send(): Promise<void> {
    this.calls += 1;
    await Promise.resolve();
    if (this.calls <= this.failures) {
      throw this.error;
    }
  }
}

describe('RetryingEmailProvider', () => {
  it('does not retry a first-try success', async () => {
    const inner = new FlakyProvider(0, new SendError('x', 'transient'));
    const sleeper = new RecordingSleeper();

    await new RetryingEmailProvider(inner, PACING, sleeper, () => 0.5).send(MESSAGE);
    expect(inner.calls).toBe(1);
    expect(sleeper.delays).toEqual([]);
  });

  it('retries transient failures then succeeds (full jitter)', async () => {
    const inner = new FlakyProvider(2, new SendError('boom', 'transient'));
    const sleeper = new RecordingSleeper();

    await new RetryingEmailProvider(inner, PACING, sleeper, () => 0.5).send(MESSAGE);
    expect(inner.calls).toBe(3);
    expect(sleeper.delays).toEqual([250, 500]);
  });

  it('gives up after maxRetries', async () => {
    const inner = new FlakyProvider(Number.POSITIVE_INFINITY, new SendError('boom', 'transient'));

    await expect(
      new RetryingEmailProvider(inner, PACING, new RecordingSleeper(), () => 0).send(MESSAGE),
    ).rejects.toBeInstanceOf(SendError);
    expect(inner.calls).toBe(4);
  });

  it.each([
    ['permanent', new SendError('nope', 'permanent')],
    ['auth', new SendError('401', 'auth')],
    ['uncertain', new SendError('timeout after the request left', 'uncertain')],
    ['non-SendError', new Error('unexpected')],
  ])('does not retry a %s failure', async (_label, error) => {
    const inner = new FlakyProvider(1, error);

    await expect(
      new RetryingEmailProvider(inner, PACING, new RecordingSleeper(), () => 0).send(MESSAGE),
    ).rejects.toThrow();
    expect(inner.calls).toBe(1);
  });

  it('waits out throttling as long as the server asks, without using up the retries', async () => {
    const inner = new FlakyProvider(5, new SendError('429', 'throttled', { retryAfterMs: 120_000 }));
    const sleeper = new RecordingSleeper();

    await new RetryingEmailProvider(inner, PACING, sleeper, () => 0.5).send(MESSAGE);
    expect(inner.calls).toBe(6);
    expect(sleeper.delays).toEqual([120_000, 120_000, 120_000, 120_000, 120_000]);
  });

  it('caps a single Retry-After and fails as throttled once the total wait is exhausted', async () => {
    const sleeper = new RecordingSleeper();
    const inner = new FlakyProvider(
      Number.POSITIVE_INFINITY,
      new SendError('429', 'throttled', { retryAfterMs: 9_999_999 }),
    );
    const sending = new RetryingEmailProvider(inner, PACING, sleeper, () => 0.5).send(MESSAGE);

    await expect(sending).rejects.toMatchObject({ category: 'throttled' });
    expect(sleeper.delays).toEqual([900_000]);
  });

  it('without a usable Retry-After, waits at least 1 s and doubles each time, so it always ends', async () => {
    const sleeper = new RecordingSleeper();
    const inner = new FlakyProvider(Number.POSITIVE_INFINITY, new SendError('429', 'throttled', { retryAfterMs: 0 }));
    const sending = new RetryingEmailProvider(inner, { ...PACING, maxThrottleWaitMs: 20_000 }, sleeper, () => 0.5).send(
      MESSAGE,
    );

    await expect(sending).rejects.toMatchObject({ category: 'throttled' });
    expect(sleeper.delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('stops retrying as soon as the run is stopping', async () => {
    const controller = new AbortController();

    class AbortingSleeper implements Sleeper {
      async sleep(): Promise<void> {
        controller.abort();
        await Promise.resolve();
      }
    }

    const inner = new FlakyProvider(Number.POSITIVE_INFINITY, new SendError('boom', 'transient'));
    const sending = new RetryingEmailProvider(inner, PACING, new AbortingSleeper(), () => 0).send(MESSAGE, {
      signal: controller.signal,
    });

    await expect(sending).rejects.toBeInstanceOf(SendCancelledError);
    expect(inner.calls).toBe(1);
  });
});
