import { type EmailAddress, normalizeEmail } from '@mailroll/core';
import { type CcPrompts, resolveCcInteractive } from '../cli/cc';
import type { ListStatus } from '../status/list-status';
import type { MenuPrompts } from './menu-prompts';
import { ccLabel, listLabel } from './review-table';

export interface CcTarget {
  readonly list: ListStatus;
  cc: readonly EmailAddress[];
}

export interface CcStepDeps {
  readonly prompts: MenuPrompts;
  readonly ccPrompts: CcPrompts;
  readonly envCc: string | undefined;
}

export function acceptsCc(target: CcTarget): boolean {
  return target.list.template.ccPolicy !== 'forbidden';
}

const ALL = 'all';

export async function editCc(targets: readonly CcTarget[], deps: CcStepDeps): Promise<void> {
  const capable = targets.filter(acceptsCc);
  const [only] = capable;

  if (only === undefined) {
    return;
  }

  let chosen: readonly CcTarget[] = [only];

  if (capable.length > 1) {
    const pick = await deps.prompts.select<CcTarget | typeof ALL>('Change the CC of which list?', [
      ...capable.map((target) => ({
        name: `${listLabel(target.list)} — CC: ${ccLabel(target.list, target.cc)}`,
        value: target,
      })),
      { name: 'All of the lists above (one CC for every one of them)', value: ALL },
    ]);

    chosen = pick === ALL ? capable : [pick];
  }

  const cc = await resolveCcInteractive({
    envRaw: deps.envCc,
    current: sharedCc(chosen),
    required: false,
    prompts: deps.ccPrompts,
  });

  for (const target of chosen) {
    target.cc = cc;
  }
}

function sharedCc(targets: readonly CcTarget[]): readonly EmailAddress[] {
  const [first, ...rest] = targets;

  if (first === undefined) {
    return [];
  }

  const key = (cc: readonly EmailAddress[]): string => JSON.stringify(cc.map(normalizeEmail).sort());

  return rest.every((target) => key(target.cc) === key(first.cc)) ? first.cc : [];
}
