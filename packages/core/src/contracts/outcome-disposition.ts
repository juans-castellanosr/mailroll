import type { ValidatedSendOutcome } from './validate-send-outcome';

export type OutcomeDisposition =
  | { readonly kind: 'record-sent' }
  | { readonly kind: 'record-uncertain' }
  | { readonly kind: 'record-failed' }
  | { readonly kind: 'retry'; readonly whenExhausted: 'record-failed' | 'stop-connection' }
  | { readonly kind: 'stop-connection' };

export function dispositionOf(outcome: ValidatedSendOutcome): OutcomeDisposition {
  switch (outcome.outcome) {
    case 'accepted':
      return { kind: 'record-sent' };
    case 'unknown':
      return { kind: 'record-uncertain' };
    case 'not-accepted':
      switch (outcome.reason) {
        case 'transient':
        case 'throttled':
          return { kind: 'retry', whenExhausted: outcome.scope === 'connection' ? 'stop-connection' : 'record-failed' };
        case 'auth':
          return { kind: 'stop-connection' };
        case 'permanent':
          return outcome.scope === 'connection' ? { kind: 'stop-connection' } : { kind: 'record-failed' };
      }
  }
}
