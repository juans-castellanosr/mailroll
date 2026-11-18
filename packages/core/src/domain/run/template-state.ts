import type { FailureCategory } from '../kernel/errors';
import { optionalField } from '../kernel/optional-field';

export interface ResendFailure {
  readonly at: string;
  readonly connectionId: string;
  readonly outcome: 'failed' | 'uncertain';
  readonly message: string;
  readonly category?: FailureCategory;
  readonly attemptId?: string;
}

export interface CcObservation {
  readonly rejected: readonly string[];
  readonly required: boolean;
}

export type RecipientStatus =
  | {
      readonly status: 'sent';
      readonly at: string;
      readonly connectionId: string;
      readonly attemptId?: string;
      readonly providerMessageId?: string;
      readonly cc?: CcObservation;
      readonly resendFailure?: ResendFailure;
      readonly uncertainAttemptIds?: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly at: string;
      readonly connectionId: string;
      readonly category: FailureCategory;
      readonly message: string;
      readonly attemptId?: string;
      readonly uncertainAttemptIds?: readonly string[];
    }
  | {
      readonly status: 'uncertain';
      readonly at: string;
      readonly connectionId: string;
      readonly message: string;
      readonly attemptId?: string;
      readonly resendFailure?: ResendFailure;
      readonly uncertainAttemptIds?: readonly string[];
    };

export interface TemplateState {
  readonly version: 2;
  readonly templateId: string;
  readonly recipients: Readonly<Record<string, RecipientStatus>>;
  readonly updatedAt: string;
}

export type RecipientJournalEntry =
  | { readonly email: string; readonly status: RecipientStatus }
  | {
      readonly email: string;
      readonly intent: { readonly at: string; readonly connectionId: string; readonly attemptId?: string };
    }
  | { readonly email: string; readonly released: { readonly at: string } };

export const emptyState = (templateId: string): TemplateState => ({
  version: 2,
  templateId,
  recipients: {},
  updatedAt: new Date(0).toISOString(),
});

export function settleStatus(previous: RecipientStatus | undefined, next: RecipientStatus): RecipientStatus {
  return withUncertainHistory(settledRecord(previous, next), [previous, next]);
}

function settledRecord(previous: RecipientStatus | undefined, next: RecipientStatus): RecipientStatus {
  if (previous === undefined || previous.status === 'failed' || next.status === 'sent') {
    return next;
  }

  if (previous.status === 'uncertain' && next.status === 'uncertain') {
    return next;
  }

  const resendFailure: ResendFailure = {
    at: next.at,
    connectionId: next.connectionId,
    outcome: next.status,
    message: next.message,
    ...(next.status === 'failed' ? { category: next.category } : {}),
    ...optionalField('attemptId', next.attemptId),
  };

  return { ...previous, resendFailure };
}

function withUncertainHistory(
  settled: RecipientStatus,
  sources: readonly (RecipientStatus | undefined)[],
): RecipientStatus {
  const shown = uncertainIdsShownBy(settled);
  const known = sources.flatMap((source) => [...(source?.uncertainAttemptIds ?? []), ...uncertainIdsShownBy(source)]);
  const kept = [...new Set(known)].filter((id) => !shown.includes(id));
  const { uncertainAttemptIds: _replaced, ...record } = settled;

  return kept.length === 0 ? record : { ...record, uncertainAttemptIds: kept };
}

function uncertainIdsShownBy(status: RecipientStatus | undefined): string[] {
  const resend = status === undefined || status.status === 'failed' ? undefined : status.resendFailure;

  return [
    status?.status === 'uncertain' ? status.attemptId : undefined,
    resend?.outcome === 'uncertain' ? resend.attemptId : undefined,
  ].filter((id) => id !== undefined);
}

export const INTERRUPTED_MESSAGE =
  'the run ended before the outcome of this send was recorded (crash, kill or power loss)';
