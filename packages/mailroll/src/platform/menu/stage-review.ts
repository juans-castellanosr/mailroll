import { type EmailAddress, parseEmailAddress, type TemplateTarget } from '@mailroll/core';
import type { Breadcrumb } from './breadcrumb';
import { type CcStepDeps, type CcTarget, acceptsCc, editCc } from './cc-step';
import { describeStatus, type ListStatus, statusOf } from '../status/list-status';
import type { MenuChoice, MenuPrompts } from './menu-prompts';
import { ccLabel, listLabel, panelTitle, renderTable } from './review-table';

export interface StageReviewDeps extends CcStepDeps {
  readonly breadcrumb: Breadcrumb;
  readonly testRecipientDefault: string | undefined;
  readonly random: () => number;
}

export interface ReviewedStage {
  readonly testRecipient: EmailAddress;
  readonly targets: readonly TemplateTarget[];
}

type Scope = 'random' | 'chosen' | 'all';
type Action = 'go' | 'inbox' | 'cc' | 'scope' | 'redraw' | 'pick' | 'cancel';

interface StageTarget extends CcTarget {
  sample?: EmailAddress;
}

const SCOPE_TEXT: Readonly<Record<Scope, string>> = {
  random: 'One random recipient per list',
  chosen: 'One recipient per list, chosen by you',
  all: 'Every recipient of each list (all of them land in the test inbox)',
};

export async function reviewStage(
  lists: readonly ListStatus[],
  deps: StageReviewDeps,
): Promise<ReviewedStage | undefined> {
  const draft: StageTarget[] = lists.map((list) => ({ list, cc: list.template.cc ?? [] }));
  let testRecipient = defaultTestInbox(deps) ?? (await askTestInbox(undefined, deps.prompts));
  let scope: Scope = 'random';

  drawRandom(draft, deps.random);

  for (;;) {
    const total = countMessages(draft, scope);

    printPanel(draft, scope, testRecipient, total, deps.prompts);
    const action = await deps.prompts.select<Action>('What next?', actions(draft, scope, total), 'go');

    switch (action) {
      case 'go':
        deps.breadcrumb.set('Test inbox', testRecipient);

        return { testRecipient, targets: toTargets(draft, scope) };
      case 'inbox':
        testRecipient = await askTestInbox(testRecipient, deps.prompts);
        break;
      case 'cc':
        await editCc(draft, deps);
        break;
      case 'scope':
        scope = await deps.prompts.select<Scope>(
          'Which rows to render into the test inbox?',
          (Object.keys(SCOPE_TEXT) as Scope[]).map((value) => ({ name: SCOPE_TEXT[value], value })),
          scope,
        );
        if (scope === 'random') {
          drawRandom(draft, deps.random);
        } else if (scope === 'chosen') {
          await pickSamples(draft, deps.prompts);
        }
        break;
      case 'redraw':
        drawRandom(draft, deps.random);
        break;
      case 'pick':
        await pickSamples(draft, deps.prompts);
        break;
      case 'cancel':
        return undefined;
    }
  }
}

function actions(draft: readonly StageTarget[], scope: Scope, total: number): MenuChoice<Action>[] {
  const choices: MenuChoice<Action>[] = [
    {
      name: `Send ${String(total)} test email(s) to the test inbox`,
      value: 'go',
      ...(total === 0 ? { disabled: 'every selected list is empty' } : {}),
    },
    { name: 'Edit test inbox', value: 'inbox' },
  ];

  if (draft.some(acceptsCc)) {
    choices.push({ name: 'Edit CC', value: 'cc' });
  }

  choices.push({ name: 'Change scope (random · chosen · whole list)', value: 'scope' });
  if (scope === 'random') {
    choices.push({ name: 'Draw other random recipients', value: 'redraw' });
  }

  if (scope === 'chosen') {
    choices.push({ name: 'Choose the recipients again', value: 'pick' });
  }

  choices.push({ name: 'Cancel (nothing is sent)', value: 'cancel' });

  return choices;
}

function printPanel(
  draft: readonly StageTarget[],
  scope: Scope,
  testRecipient: EmailAddress,
  total: number,
  prompts: MenuPrompts,
): void {
  const rows = draft.map((target) => [
    listLabel(target.list),
    renderedRows(target, scope),
    ccLabel(target.list, target.cc),
  ]);

  prompts.print([
    panelTitle('Review · Stage/UAT test send'),
    `  Test inbox   ${testRecipient}   (receives every message; the people in the lists receive nothing)`,
    `  Scope        ${SCOPE_TEXT[scope]}`,
    '  History      not recorded (test sends never change who counts as sent)',
    ...(draft.some((t) => acceptsCc(t) && t.cc.length > 0)
      ? ['  CC           the CC shown per list DOES receive a copy of each test email — use "Edit CC" to change it']
      : []),
    '',
    ...renderTable([{ header: 'Template · CSV' }, { header: 'Rendered from' }, { header: 'CC' }], rows),
    `  Total: ${String(total)} test email(s)`,
    '',
  ]);
}

function renderedRows(target: StageTarget, scope: Scope): string {
  if (target.list.recipients.length === 0) {
    return '(empty list — skipped)';
  }

  if (scope === 'all') {
    return `all ${String(target.list.recipients.length)} recipients`;
  }

  return target.sample ?? '—';
}

function countMessages(draft: readonly StageTarget[], scope: Scope): number {
  return draft.reduce(
    (sum, target) => sum + (scope === 'all' ? target.list.recipients.length : target.sample !== undefined ? 1 : 0),
    0,
  );
}

function drawRandom(draft: StageTarget[], random: () => number): void {
  for (const target of draft) {
    const { recipients } = target.list;
    const index = Math.min(recipients.length - 1, Math.floor(random() * recipients.length));
    const sample = recipients[index];

    if (sample !== undefined) {
      target.sample = sample;
    } else {
      delete target.sample;
    }
  }
}

async function pickSamples(draft: StageTarget[], prompts: MenuPrompts): Promise<void> {
  for (const target of draft) {
    const { list } = target;

    if (list.recipients.length === 0) {
      continue;
    }

    target.sample = await prompts.select(
      `Recipient to render for ${listLabel(list)}`,
      list.recipients.map((recipient) => ({
        name: `${recipient} — ${describeStatus(statusOf(list, recipient))}`,
        value: recipient,
      })),
      target.sample,
    );
  }
}

async function askTestInbox(current: EmailAddress | undefined, prompts: MenuPrompts): Promise<EmailAddress> {
  const raw = await prompts.input('Test inbox (every test message goes here)', {
    ...(current !== undefined ? { default: current } : {}),
    validate: (value) => (parseEmailAddress(value).ok ? true : 'Enter a valid email address'),
  });
  const outcome = parseEmailAddress(raw);

  if (!outcome.ok) {
    throw new Error('invalid test inbox address');
  }

  return outcome.value;
}

function defaultTestInbox(deps: StageReviewDeps): EmailAddress | undefined {
  const raw = deps.testRecipientDefault;

  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const outcome = parseEmailAddress(raw);

  if (!outcome.ok) {
    deps.prompts.print([
      `! TEST_RECIPIENT "${raw}" is not a valid address (${outcome.reasons.join('; ')}); enter the test inbox instead.`,
    ]);

    return undefined;
  }

  return outcome.value;
}

function toTargets(draft: readonly StageTarget[], scope: Scope): TemplateTarget[] {
  return draft.flatMap((target): TemplateTarget[] => {
    const base = {
      templateId: target.list.template.id,
      dataFile: target.list.dataFile,
      dataFingerprint: target.list.fingerprint,
      ...(acceptsCc(target) ? { cc: target.cc } : {}),
    };

    if (scope === 'all') {
      return target.list.recipients.length > 0 ? [{ ...base, policy: { kind: 'force-all' } }] : [];
    }

    return target.sample !== undefined ? [{ ...base, policy: { kind: 'subset', recipients: [target.sample] } }] : [];
  });
}
