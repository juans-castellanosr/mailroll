import type { Pacing } from '../domain/catalog/pacing';

export interface RetryState {
  retries: number;
  throttles: number;
  throttledMs: number;
}

export interface RetryableFailure {
  readonly reason: 'transient' | 'throttled';
  readonly retryAfterMs?: number;
  readonly detail: string;
}

export type RetryDecision = { readonly wait: number } | { readonly exhausted: string };

const MIN_THROTTLE_WAIT_MS = 1_000;

export const freshRetryState = (): RetryState => ({ retries: 0, throttles: 0, throttledMs: 0 });

export function nextRetry(
  failure: RetryableFailure,
  state: RetryState,
  pacing: Pacing,
  random: () => number,
): RetryDecision {
  if (failure.reason === 'throttled') {
    const hinted = failure.retryAfterMs !== undefined && failure.retryAfterMs > 0 ? failure.retryAfterMs : undefined;
    const wait = Math.min(
      hinted ?? Math.max(MIN_THROTTLE_WAIT_MS, pacing.baseBackoffMs) * 2 ** state.throttles,
      pacing.maxRetryAfterMs,
    );

    if (!(state.throttledMs + wait <= pacing.maxThrottleWaitMs)) {
      return {
        exhausted: `${failure.detail} — still throttled after waiting ${String(Math.round(state.throttledMs / 1000))} s (limit ${String(Math.round(pacing.maxThrottleWaitMs / 1000))} s)`,
      };
    }

    state.throttles += 1;
    state.throttledMs += wait;

    return { wait };
  }

  if (!(state.retries < pacing.maxRetries)) {
    return { exhausted: failure.detail };
  }

  const capped = Math.min(pacing.baseBackoffMs * 2 ** state.retries, pacing.maxBackoffMs);

  state.retries += 1;

  return { wait: Math.floor(random() * capped) };
}
