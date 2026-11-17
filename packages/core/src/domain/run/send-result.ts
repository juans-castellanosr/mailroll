import type { EmailAddress } from '../addressing/email-address';
import type { FailureCategory } from '../kernel/errors';
import type { CcObservation } from './template-state';

export type SendResult =
  | {
      readonly status: 'sent';
      readonly recipient: EmailAddress;
      readonly connectionId: string;
      readonly at: string;
      readonly attemptId?: string;
      readonly providerMessageId?: string;
      readonly cc?: CcObservation;
    }
  | {
      readonly status: 'failed';
      readonly recipient: EmailAddress;
      readonly connectionId: string;
      readonly category: FailureCategory;
      readonly message: string;
      readonly at: string;
      readonly attemptId?: string;
    }
  | {
      readonly status: 'uncertain';
      readonly recipient: EmailAddress;
      readonly connectionId: string;
      readonly message: string;
      readonly at: string;
      readonly attemptId?: string;
    }
  | { readonly status: 'not-attempted'; readonly recipient: EmailAddress; readonly reason: string }
  | {
      readonly status: 'skipped';
      readonly identifier: string;
      readonly reasons: readonly string[];
      readonly code?: SkipCode;
    };

export type SkipCode = 'already-sent' | 'held-uncertain' | 'not-selected' | 'not-in-list' | 'not-failed';

export type SkippedResult = Extract<SendResult, { readonly status: 'skipped' }>;
