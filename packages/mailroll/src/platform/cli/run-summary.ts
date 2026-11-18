import { needsAttention, type SendResult, type SendSelection } from '@mailroll/core';
import type { ListRef, TemplateRunResult } from '../composition/build-runner';
import { type Output, styled } from './output';

export interface AttentionItem {
  readonly address: string;
  readonly status: 'failed' | 'uncertain' | 'not-attempted' | 'held-uncertain' | 'cc-rejected';
  readonly detail: string;
  readonly attemptId?: string;
  readonly providerMessageId?: string;
}

export interface RejectedCcItem {
  readonly address: string;
  readonly cc: readonly string[];
  readonly required: boolean;
  readonly attemptId?: string;
  readonly providerMessageId?: string;
}

export interface Interruption {
  readonly reason: string;
  readonly notRun: readonly ListRef[];
}

export interface RunSummaryJson {
  readonly campaignId: string;
  readonly mode: SendSelection['mode']['kind'];
  readonly needsAttention: boolean;
  readonly interrupted?: Interruption;
  readonly lists: readonly {
    readonly templateId: string;
    readonly dataFile: string;
    readonly policy: string;
    readonly statePath: string;
    readonly previewDir?: string;
    readonly counts: {
      readonly total: number;
      readonly sent: number;
      readonly failed: number;
      readonly uncertain: number;
      readonly notAttempted: number;
      readonly skipped: number;
      readonly ccRejectedMessages: number;
      readonly requiredCcRejectedMessages: number;
    };
    readonly attention: readonly AttentionItem[];
    readonly ccRejected: readonly RejectedCcItem[];
  }[];
}

function withAttempt(result: { readonly attemptId?: string }): { readonly attemptId?: string } {
  return result.attemptId === undefined ? {} : { attemptId: result.attemptId };
}

export function rejectedCcItems(results: readonly SendResult[]): RejectedCcItem[] {
  return results.flatMap((result) =>
    result.status === 'sent' && result.cc !== undefined && result.cc.rejected.length > 0
      ? [
          {
            address: result.recipient,
            cc: result.cc.rejected,
            required: result.cc.required,
            ...withAttempt(result),
            ...(result.providerMessageId === undefined ? {} : { providerMessageId: result.providerMessageId }),
          },
        ]
      : [],
  );
}

type RunModeOf = SendSelection['mode'];

function requiredCcDetail(mode: RunModeOf, recipient: string, rejected: readonly string[]): string {
  return mode.kind === 'live'
    ? `required CC rejected: ${rejected.join(', ')}; the provider accepted the message for ${recipient}, so it is not queued again`
    : `required CC rejected on the ${mode.kind} send${mode.kind === 'test' ? ` to ${mode.testRecipient}` : ''} for ${recipient}: ${rejected.join(', ')}; nothing was recorded`;
}

export function attentionOf(results: readonly SendResult[], mode: RunModeOf): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const result of results) {
    switch (result.status) {
      case 'failed':
        items.push({
          address: result.recipient,
          status: 'failed',
          detail: `[${result.category}] ${result.message}`,
          ...withAttempt(result),
        });
        break;
      case 'uncertain':
        items.push({
          address: result.recipient,
          status: 'uncertain',
          detail: `${result.message} — check before resending`,
          ...withAttempt(result),
        });
        break;
      case 'not-attempted':
        items.push({ address: result.recipient, status: 'not-attempted', detail: result.reason });
        break;
      case 'skipped':
        if (result.code === 'held-uncertain') {
          items.push({
            address: result.identifier,
            status: 'held-uncertain',
            detail: 'still uncertain from an earlier run',
          });
        }
        break;
      case 'sent':
        if (result.cc?.required === true && result.cc.rejected.length > 0) {
          items.push({
            address: result.recipient,
            status: 'cc-rejected',
            detail: requiredCcDetail(mode, result.recipient, result.cc.rejected),
            ...withAttempt(result),
            ...(result.providerMessageId === undefined ? {} : { providerMessageId: result.providerMessageId }),
          });
        }
        break;
    }
  }

  return items;
}

export function summaryJson(
  selection: SendSelection,
  results: readonly TemplateRunResult[],
  interruption?: Interruption,
): RunSummaryJson {
  return {
    campaignId: selection.campaignId,
    mode: selection.mode.kind,
    needsAttention: interruption !== undefined || results.some((r) => needsAttention(r.report)),
    ...(interruption !== undefined ? { interrupted: interruption } : {}),
    lists: results.map(({ templateId, dataFile, policy, statePath, previewDir, report }) => ({
      templateId,
      dataFile,
      policy,
      statePath,
      ...(previewDir !== undefined ? { previewDir } : {}),
      counts: {
        total: report.total,
        sent: report.sent,
        failed: report.failed,
        uncertain: report.uncertain,
        notAttempted: report.notAttempted,
        skipped: report.skipped,
        ccRejectedMessages: report.ccRejectedMessages,
        requiredCcRejectedMessages: report.requiredCcRejectedMessages,
      },
      attention: attentionOf(report.results, selection.mode),
      ccRejected: rejectedCcItems(report.results),
    })),
  };
}

const MARK: Readonly<Record<AttentionItem['status'], string>> = {
  failed: 'failed',
  uncertain: 'UNCERTAIN',
  'not-attempted': 'not attempted',
  'held-uncertain': 'still UNCERTAIN',
  'cc-rejected': 'CC REJECTED (required)',
};

function evidenceLine(attemptId: string | undefined, providerMessageId?: string): string | undefined {
  const parts = [
    ...(attemptId === undefined ? [] : [`attempt ${attemptId}`]),
    ...(providerMessageId === undefined ? [] : [`provider id ${providerMessageId}`]),
  ];

  return parts.length === 0 ? undefined : `      ${parts.join(' · ')} (for tracing; not proof of delivery)`;
}

export function printSummary(
  out: Output,
  selection: SendSelection,
  results: readonly TemplateRunResult[],
  interruption?: Interruption,
): void {
  const mode = selection.mode;
  const verb = mode.kind === 'dry-run' ? 'rendered' : 'sent';

  out.data('');
  out.data(
    styled('strong', selection.campaignId),
    ` — ${mode.kind}${mode.kind === 'test' ? ` (every message to ${mode.testRecipient})` : ''}`,
  );

  for (const { templateId, dataFile, policy, statePath, previewDir, report } of results) {
    const ok = !needsAttention(report);
    const ccNote =
      report.ccRejectedMessages > 0
        ? `, CC rejected on ${String(report.ccRejectedMessages)} message(s) (${String(report.requiredCcRejectedMessages)} required)`
        : '';

    out.data(
      `  ${templateId} · ${dataFile} [${policy}] `,
      ok ? styled('success', 'ok') : styled('warning', 'needs attention'),
      `: ${verb} ${String(report.sent)}, failed ${String(report.failed)}, uncertain ${String(report.uncertain)}, not attempted ${String(report.notAttempted)}, skipped ${String(report.skipped)}${ccNote}`,
    );

    if (previewDir !== undefined) {
      out.data(styled('muted', `    previews: ${previewDir}`));
    } else if (mode.kind === 'live') {
      out.data(styled('muted', `    history: ${statePath}`));
    }

    for (const item of attentionOf(report.results, mode)) {
      out.data(`    ${MARK[item.status]}: ${item.address} — ${item.detail}`);

      const evidence = evidenceLine(item.attemptId, item.providerMessageId);

      if (evidence !== undefined) {
        out.data(styled('muted', evidence));
      }
    }

    for (const item of rejectedCcItems(report.results).filter((entry) => !entry.required)) {
      const where =
        mode.kind === 'live'
          ? ''
          : ` on the ${mode.kind} send${mode.kind === 'test' ? ` to ${mode.testRecipient}` : ''}, nothing recorded`;

      out.data(`    note: CC rejected (optional${where}): ${item.address} — ${item.cc.join(', ')}`);

      const evidence = evidenceLine(item.attemptId, item.providerMessageId);

      if (evidence !== undefined) {
        out.data(styled('muted', evidence));
      }
    }
  }

  if (interruption !== undefined) {
    out.data(styled('warning', '  stopped before the run finished'), `: ${interruption.reason}`);

    for (const list of interruption.notRun) {
      out.data(`    not run: ${list.templateId} · ${list.dataFile}`);
    }
  }

  out.data('');
}
