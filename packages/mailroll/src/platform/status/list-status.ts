import {
  type EmailAddress,
  normalizeEmail,
  planRun,
  type PreparedTemplate,
  type RecipientStatus,
  type ResendPolicy,
  type SkippedResult,
  type StateStore,
  type Template,
  type TemplateState,
  upgradeTemplateState,
} from '@mailroll/core';
import { fileFingerprint } from '../composition/file-fingerprint';
import { recipientSource } from '../composition/recipient-source';
import { resolveTemplate } from '../composition/resolve-template';
import type { HistoryPresence } from '../state/history-presence';

export type HistoryInspector = (statePath: string) => Promise<HistoryPresence>;

export interface ListStatus {
  readonly template: Template;
  readonly dataFile: string;
  readonly recipients: readonly EmailAddress[];
  readonly rejected: readonly SkippedResult[];
  readonly state: TemplateState;
  readonly fingerprint: string;
  readonly history?: HistoryPresence;
}

export interface ListCounts {
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly pending: number;
  readonly rejected: number;
  readonly ccRejectedMessages: number;
  readonly requiredCcRejectedMessages: number;
}

export interface EvidenceItem {
  readonly email: string;
  readonly status: RecipientStatus['status'];
  readonly at: string;
  readonly attemptId?: string;
  readonly providerMessageId?: string;
  readonly uncertainAttemptIds?: readonly string[];
  readonly cc?: { readonly rejected: readonly string[]; readonly required: boolean };
  readonly uncertainResend?: { readonly at: string; readonly attemptId?: string };
}

export async function loadListStatus(
  template: Template,
  dataFile: string,
  prepared: PreparedTemplate,
  store: StateStore,
  inspect?: HistoryInspector,
): Promise<ListStatus> {
  const resolved = resolveTemplate(template, dataFile);
  const fingerprint = await fileFingerprint(resolved.dataPath);
  const listing = await prepared.listRecipients(recipientSource(resolved.dataPath));
  const state = upgradeTemplateState(await store.load(resolved));

  return {
    template,
    dataFile,
    recipients: listing.accepted,
    rejected: listing.rejected,
    state,
    fingerprint,
    ...(inspect === undefined ? {} : { history: await inspect(resolved.statePath) }),
  };
}

export function statusOf(list: ListStatus, recipient: EmailAddress): RecipientStatus | undefined {
  return list.state.recipients[normalizeEmail(recipient)];
}

export function countList(list: ListStatus): ListCounts {
  let sent = 0;
  let failed = 0;
  let uncertain = 0;
  let ccRejectedMessages = 0;
  let requiredCcRejectedMessages = 0;

  for (const recipient of list.recipients) {
    const record = statusOf(list, recipient);
    const status = record?.status;

    if (status === 'sent') {
      sent += 1;
    } else if (status === 'failed') {
      failed += 1;
    } else if (status === 'uncertain') {
      uncertain += 1;
    }

    if (record?.status === 'sent' && record.cc !== undefined && record.cc.rejected.length > 0) {
      ccRejectedMessages += 1;
      requiredCcRejectedMessages += record.cc.required ? 1 : 0;
    }
  }

  return {
    total: list.recipients.length,
    sent,
    failed,
    uncertain,
    pending: list.recipients.length - sent - uncertain,
    rejected: list.rejected.length,
    ccRejectedMessages,
    requiredCcRejectedMessages,
  };
}

function uncertainResendOf(record: RecipientStatus): { readonly at: string; readonly attemptId?: string } | undefined {
  const resend = record.status === 'failed' ? undefined : record.resendFailure;

  return resend?.outcome === 'uncertain'
    ? { at: resend.at, ...(resend.attemptId === undefined ? {} : { attemptId: resend.attemptId }) }
    : undefined;
}

export function evidenceOf(list: ListStatus): EvidenceItem[] {
  return list.recipients.flatMap((recipient) => {
    const record = statusOf(list, recipient);

    if (record === undefined) {
      return [];
    }

    const cc =
      record.status === 'sent' && record.cc !== undefined && record.cc.rejected.length > 0 ? record.cc : undefined;
    const uncertainResend = uncertainResendOf(record);
    const earlier = record.uncertainAttemptIds ?? [];

    if (record.status !== 'uncertain' && cc === undefined && uncertainResend === undefined && earlier.length === 0) {
      return [];
    }

    return [
      {
        email: normalizeEmail(recipient),
        status: record.status,
        at: record.at,
        ...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
        ...(record.status === 'sent' && record.providerMessageId !== undefined
          ? { providerMessageId: record.providerMessageId }
          : {}),
        ...(earlier.length === 0 ? {} : { uncertainAttemptIds: earlier }),
        ...(cc === undefined ? {} : { cc }),
        ...(uncertainResend === undefined ? {} : { uncertainResend }),
      },
    ];
  });
}

export function describeEvidence(item: EvidenceItem): string {
  const parts = [
    item.status === 'uncertain' ? 'UNCERTAIN' : item.status,
    ...(item.cc === undefined
      ? []
      : [`CC rejected${item.cc.required ? ' (required)' : ''}: ${item.cc.rejected.join(', ')}`]),
    ...(item.uncertainResend === undefined
      ? []
      : [
          `a later resend is uncertain${item.uncertainResend.attemptId === undefined ? '' : ` (attempt ${item.uncertainResend.attemptId})`}`,
        ]),
    ...(item.attemptId === undefined ? [] : [`attempt ${item.attemptId}`]),
    ...(item.providerMessageId === undefined ? [] : [`provider id ${item.providerMessageId}`]),
    ...(item.uncertainAttemptIds === undefined
      ? []
      : [`earlier uncertain attempts ${item.uncertainAttemptIds.join(', ')}`]),
  ];

  return `${item.email}: ${parts.join(' · ')} (for tracing; not proof of delivery)`;
}

export function hasHistory(list: ListStatus): boolean {
  const counts = countList(list);

  return counts.sent + counts.failed + counts.uncertain > 0;
}

export function plannedRecipients(list: ListStatus, policy: ResendPolicy): readonly EmailAddress[] {
  const plan = planRun({ recipients: list.recipients, state: list.state, policy, connectionIds: ['menu'] });

  return plan.assignments.map((assignment) => assignment.recipient);
}

export function describeStatus(status: RecipientStatus | undefined): string {
  if (status === undefined) {
    return 'not sent yet';
  }

  const day = status.at.slice(0, 10);

  switch (status.status) {
    case 'sent': {
      const resend =
        status.resendFailure !== undefined
          ? ` (a later resend ${status.resendFailure.outcome === 'failed' ? 'failed' : 'is uncertain'})`
          : '';
      const cc =
        status.cc !== undefined && status.cc.rejected.length > 0
          ? ` (CC rejected${status.cc.required ? ', required' : ''}: ${status.cc.rejected.join(', ')})`
          : '';

      return `sent ${day}${resend}${cc}`;
    }

    case 'failed':
      return `failed ${day} (${status.category})`;
    case 'uncertain':
      return `UNCERTAIN ${day} — may have been delivered; check before resending`;
  }
}

export function formatCounts(counts: ListCounts): string {
  const base = `${String(counts.total)} in list · sent ${String(counts.sent)} · failed ${String(counts.failed)} · pending ${String(counts.pending)}`;
  const uncertain = counts.uncertain > 0 ? ` · uncertain ${String(counts.uncertain)}` : '';
  const rejected = counts.rejected > 0 ? ` · ${String(counts.rejected)} row(s) rejected` : '';
  const cc =
    counts.ccRejectedMessages > 0
      ? ` · CC rejected ${String(counts.ccRejectedMessages)} (${String(counts.requiredCcRejectedMessages)} required)`
      : '';

  return `${base}${uncertain}${rejected}${cc}`;
}
