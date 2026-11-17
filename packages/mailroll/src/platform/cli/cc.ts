import { type EmailAddress, normalizeEmail, parseEmailAddress } from '@mailroll/core';
import { CliError } from './cli-error';

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function dedupeAddresses(addresses: readonly EmailAddress[]): readonly EmailAddress[] {
  const seen = new Set<string>();
  const unique: EmailAddress[] = [];

  for (const address of addresses) {
    const key = normalizeEmail(address);

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(address);
    }
  }

  return unique;
}

function toAddresses(values: readonly string[]): EmailAddress[] {
  return values.map((value) => {
    const outcome = parseEmailAddress(value);

    if (!outcome.ok) {
      throw new CliError(`invalid CC address "${value}": ${outcome.reasons.join('; ')}`);
    }

    return outcome.value;
  });
}

export function parseCcList(raw: string): readonly EmailAddress[] {
  return dedupeAddresses(toAddresses(splitList(raw)));
}

export interface CcPrompts {
  readonly pickFromList: (
    choices: readonly EmailAddress[],
    checked: readonly EmailAddress[],
  ) => Promise<readonly string[]>;
  readonly addNew: () => Promise<string>;
}

export interface ResolveCcInteractiveParams {
  readonly envRaw: string | undefined;
  readonly current?: readonly EmailAddress[];
  readonly required: boolean;
  readonly prompts: CcPrompts;
}

export async function resolveCcInteractive(params: ResolveCcInteractiveParams): Promise<readonly EmailAddress[]> {
  const current = params.current ?? [];
  const saved = params.envRaw !== undefined ? parseCcList(params.envRaw) : [];
  const known = dedupeAddresses([...current, ...saved]);

  const picked = known.length > 0 ? await params.prompts.pickFromList(known, current) : [];
  const typed = await params.prompts.addNew();

  const combined = [...picked, ...splitList(typed)];
  const resolved = dedupeAddresses(toAddresses(combined));

  if (params.required && resolved.length === 0) {
    throw new CliError('a CC is required for a live send — select at least one saved address or type a new one');
  }

  return resolved;
}
