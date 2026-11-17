import {
  type Connection,
  type EmailAddress,
  normalizeEmail,
  type ResendPolicy,
  type TemplateTarget,
} from '@mailroll/core';
import type { Breadcrumb } from './breadcrumb';
import { type CcStepDeps, type CcTarget, acceptsCc, editCc } from './cc-step';
import { connectionLabel } from './catalog-steps';
import {
  countList,
  describeStatus,
  hasHistory,
  type ListStatus,
  plannedRecipients,
  statusOf,
} from '../status/list-status';
import type { MenuChoice, MenuPrompts } from './menu-prompts';
import { ccLabel, listLabel, panelTitle, renderTable } from './review-table';

export type SendKind = 'dry-run' | 'live';

export interface SendReviewDeps extends CcStepDeps {
  readonly breadcrumb: Breadcrumb;
}

export interface ReviewedSend {
  readonly policy: ResendPolicy;
  readonly targets: readonly TemplateTarget[];
}

interface DraftTarget extends CcTarget {
  chosen?: readonly EmailAddress[];
}

type Action = 'go' | 'cc' | 'recipients' | 'policy' | 'cancel';
type BasePolicy = Exclude<ResendPolicy, { kind: 'subset' }>;

const POLICY_TEXT: Readonly<Record<BasePolicy['kind'], string>> = {
  pending: 'Pending only — skips anyone already sent or uncertain; lists without history go out complete',
  'failed-only': 'Retry failed only — only recipients whose previous send failed',
  'force-all': 'Force from scratch — everyone in each list again, ignoring history',
};

export async function reviewSend(
  kind: SendKind,
  lists: readonly ListStatus[],
  connections: readonly Connection[],
  deps: SendReviewDeps,
): Promise<ReviewedSend | undefined> {
  const draft: DraftTarget[] = lists.map((list) => ({ list, cc: list.template.cc ?? [] }));
  let policy: BasePolicy = { kind: 'pending' };
  const anyHistory = lists.some(hasHistory);
  const anyFailed = lists.some((list) => countList(list).failed > 0);

  for (;;) {
    const planned = (target: DraftTarget): readonly EmailAddress[] => plannedRecipients(target.list, policy);
    const willSend = (target: DraftTarget): readonly EmailAddress[] => target.chosen ?? planned(target);
    const total = draft.reduce((sum, target) => sum + willSend(target).length, 0);

    printPanel(kind, draft, policy, anyHistory, connections, willSend, total, deps.prompts);

    const action = await deps.prompts.select<Action>('What next?', actions(kind, draft, total, anyHistory), 'go');

    switch (action) {
      case 'go':
        if (kind === 'dry-run' || (await confirmLive(draft, willSend, total, connections, deps.prompts))) {
          deps.breadcrumb.set('Policy', policy.kind);

          return { policy, targets: draft.map((target) => toTarget(target)) };
        }
        break;
      case 'cc':
        await editCc(draft, deps);
        break;
      case 'recipients':
        await chooseRecipients(draft, willSend, planned, deps.prompts);
        break;
      case 'policy':
        policy = await pickPolicy(policy, anyFailed, deps.prompts);
        for (const target of draft) {
          delete target.chosen;
        }
        break;
      case 'cancel':
        return undefined;
    }
  }
}

function actions(
  kind: SendKind,
  draft: readonly DraftTarget[],
  total: number,
  anyHistory: boolean,
): MenuChoice<Action>[] {
  const missingCc = draft
    .filter((t) => t.list.template.ccPolicy === 'required' && t.cc.length === 0)
    .map((t) => t.list.template.id);
  let blocked: string | undefined;

  if (total === 0) {
    blocked = 'nothing to send with these settings';
  } else if (kind === 'live' && missingCc.length > 0) {
    blocked = `a CC is required by ${missingCc.join(', ')} — use "Change CC"`;
  }

  const goName =
    kind === 'live'
      ? `Send ${String(total)} email(s) now (real send)`
      : `Render ${String(total)} preview(s) (nothing is sent)`;
  const choices: MenuChoice<Action>[] = [
    { name: goName, value: 'go', ...(blocked !== undefined ? { disabled: blocked } : {}) },
  ];

  if (draft.some(acceptsCc)) {
    choices.push({ name: 'Change CC', value: 'cc' });
  }

  choices.push({ name: 'Choose recipients (pick exactly who receives each list)', value: 'recipients' });
  if (anyHistory) {
    choices.push({ name: 'Change policy (what to do with previous sends)', value: 'policy' });
  }

  choices.push({ name: 'Cancel (nothing is sent)', value: 'cancel' });

  return choices;
}

function printPanel(
  kind: SendKind,
  draft: readonly DraftTarget[],
  policy: BasePolicy,
  anyHistory: boolean,
  connections: readonly Connection[],
  willSend: (target: DraftTarget) => readonly EmailAddress[],
  total: number,
  prompts: MenuPrompts,
): void {
  const rows = draft.map((target) => {
    const counts = countList(target.list);

    return [
      listLabel(target.list),
      String(counts.total),
      String(counts.sent),
      String(counts.failed),
      String(counts.uncertain),
      willSendLabel(target, willSend(target)),
      ccLabel(target.list, target.cc),
    ];
  });

  prompts.print([
    panelTitle(kind === 'live' ? 'Review · Live send' : 'Review · QA preview'),
    `  Connections  ${connections.map(connectionLabel).join(', ')}`,
    `  Policy       ${anyHistory ? POLICY_TEXT[policy.kind] : 'First send — no list has history; everyone in each list'}`,
    '',
    ...renderTable(
      [
        { header: 'Template · CSV' },
        { header: 'In list', alignRight: true },
        { header: 'Sent', alignRight: true },
        { header: 'Failed', alignRight: true },
        { header: 'Uncertain', alignRight: true },
        { header: 'Will send', alignRight: true },
        { header: 'CC' },
      ],
      rows,
    ),
    `  Total: ${String(total)} email(s)${kind === 'dry-run' ? ' rendered to previews/ (no send, no state change)' : ''}`,
    '',
  ]);
}

async function confirmLive(
  draft: readonly DraftTarget[],
  willSend: (target: DraftTarget) => readonly EmailAddress[],
  total: number,
  connections: readonly Connection[],
  prompts: MenuPrompts,
): Promise<boolean> {
  const resent = draft.reduce((sum, target) => sum + alreadySent(target, willSend(target)), 0);
  const maybe = draft.reduce((sum, target) => sum + uncertainAmong(target, willSend(target)), 0);

  const ccs = new Set(draft.filter(acceptsCc).map((t) => ccLabel(t.list, t.cc)));
  const ccText = ccs.size === 0 ? 'none' : ccs.size === 1 ? [...ccs].join('') : 'per list, as shown above';
  const resendText =
    (resent > 0 ? ` ${String(resent)} of them were already sent and will receive it AGAIN.` : '') +
    (maybe > 0 ? ` ${String(maybe)} of them are UNCERTAIN (they may already have it).` : '');

  return prompts.confirm(
    `Send ${String(total)} real email(s) for ${String(draft.length)} list(s) from ${connections.map((c) => c.mailbox).join(', ')} (CC: ${ccText})?${resendText} This cannot be undone.`,
    false,
  );
}

function alreadySent(target: DraftTarget, recipients: readonly EmailAddress[]): number {
  return recipients.filter((recipient) => statusOf(target.list, recipient)?.status === 'sent').length;
}

function sentWithRejectedCc(target: DraftTarget, recipients: readonly EmailAddress[]): number {
  return recipients.filter((recipient) => {
    const record = statusOf(target.list, recipient);

    return record?.status === 'sent' && record.cc !== undefined && record.cc.rejected.length > 0;
  }).length;
}

function uncertainAmong(target: DraftTarget, recipients: readonly EmailAddress[]): number {
  return recipients.filter((recipient) => statusOf(target.list, recipient)?.status === 'uncertain').length;
}

function willSendLabel(target: DraftTarget, recipients: readonly EmailAddress[]): string {
  const notes: string[] = [];

  if (target.chosen !== undefined) {
    notes.push('chosen');
  }

  const resent = alreadySent(target, recipients);

  if (resent > 0) {
    const withRejectedCc = sentWithRejectedCc(target, recipients);
    const ccNote = withRejectedCc > 0 ? `, ${String(withRejectedCc)} of them with a rejected CC` : '';

    notes.push(`${String(resent)} already sent — will be re-sent${ccNote}`);
  }

  const maybe = uncertainAmong(target, recipients);

  if (maybe > 0) {
    notes.push(`${String(maybe)} uncertain — may already have it`);
  }

  return notes.length > 0 ? `${String(recipients.length)} (${notes.join(', ')})` : String(recipients.length);
}

async function pickPolicy(current: BasePolicy, anyFailed: boolean, prompts: MenuPrompts): Promise<BasePolicy> {
  const kind = await prompts.select<BasePolicy['kind']>(
    'Policy (resets any recipients chosen by hand)',
    [
      { name: POLICY_TEXT.pending, value: 'pending' },
      {
        name: POLICY_TEXT['failed-only'],
        value: 'failed-only',
        ...(anyFailed ? {} : { disabled: 'no list has failed sends' }),
      },
      { name: POLICY_TEXT['force-all'], value: 'force-all' },
    ],
    current.kind,
  );

  return { kind };
}

async function chooseRecipients(
  draft: readonly DraftTarget[],
  willSend: (target: DraftTarget) => readonly EmailAddress[],
  planned: (target: DraftTarget) => readonly EmailAddress[],
  prompts: MenuPrompts,
): Promise<void> {
  let target = draft[0];

  if (draft.length > 1) {
    target = await prompts.select(
      'Which list?',
      draft.map((t) => ({ name: `${listLabel(t.list)} — ${String(willSend(t).length)} will receive it`, value: t })),
    );
  }

  if (target === undefined) {
    return;
  }

  const list = target.list;

  if (list.recipients.length === 0) {
    prompts.print([`  ${listLabel(list)} has no recipients.`]);

    return;
  }

  const selected = new Set(willSend(target).map(normalizeEmail));
  const picked = await prompts.checkbox(
    `Recipients of ${listLabel(list)} (space to toggle, enter to confirm)`,
    list.recipients.map((recipient) => ({
      name: `${recipient} — ${describeStatus(statusOf(list, recipient))}`,
      value: recipient,
      checked: selected.has(normalizeEmail(recipient)),
    })),
  );
  const pickedKeys = new Set(picked.map(normalizeEmail));
  const byPolicy = new Set(planned(target).map(normalizeEmail));
  const matchesPolicy = pickedKeys.size === byPolicy.size && [...byPolicy].every((key) => pickedKeys.has(key));

  if (matchesPolicy) {
    delete target.chosen;
  } else {
    target.chosen = list.recipients.filter((recipient) => pickedKeys.has(normalizeEmail(recipient)));
  }
}

function toTarget(target: DraftTarget): TemplateTarget {
  return {
    templateId: target.list.template.id,
    dataFile: target.list.dataFile,
    dataFingerprint: target.list.fingerprint,
    ...(target.chosen !== undefined ? { policy: { kind: 'subset', recipients: target.chosen } } : {}),
    ...(acceptsCc(target) ? { cc: target.cc } : {}),
  };
}
