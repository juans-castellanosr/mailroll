import { ConfigError, type RecipientJournalEntry, type TemplateState } from '@mailroll/core';
import { z } from 'zod';
import { formatZodError } from '../config/format-zod-error';

export const JOURNAL_HEADER_LINE = JSON.stringify({ format: 'mailroll-journal', version: 2 });

const NEWER = 'it was written by a newer mailroll; upgrade mailroll to use this history';

const failureCategory = z.enum(['transient', 'permanent', 'auth', 'throttled']);

const attemptId = z.string().exactOptional();
const uncertainAttemptIds = z.array(z.string()).exactOptional();
const resendFailureV2 = z.strictObject({
  at: z.string(),
  connectionId: z.string(),
  outcome: z.enum(['failed', 'uncertain']),
  message: z.string(),
  category: failureCategory.exactOptional(),
  attemptId,
});
const statusV2 = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('sent'),
    at: z.string(),
    connectionId: z.string(),
    attemptId,
    providerMessageId: z.string().exactOptional(),
    cc: z.strictObject({ rejected: z.array(z.string()), required: z.boolean() }).exactOptional(),
    resendFailure: resendFailureV2.exactOptional(),
    uncertainAttemptIds,
  }),
  z.strictObject({
    status: z.literal('failed'),
    at: z.string(),
    connectionId: z.string(),
    category: failureCategory,
    message: z.string(),
    attemptId,
    uncertainAttemptIds,
  }),
  z.strictObject({
    status: z.literal('uncertain'),
    at: z.string(),
    connectionId: z.string(),
    message: z.string(),
    attemptId,
    resendFailure: resendFailureV2.exactOptional(),
    uncertainAttemptIds,
  }),
]);
const stateV2 = z.strictObject({
  version: z.literal(2),
  templateId: z.string(),
  recipients: z.record(z.string(), statusV2),
  updatedAt: z.string(),
});
const entryV2 = z.union([
  z.strictObject({ email: z.string(), status: statusV2 }),
  z.strictObject({
    email: z.string(),
    intent: z.strictObject({ at: z.string(), connectionId: z.string(), attemptId }),
  }),
  z.strictObject({ email: z.string(), released: z.strictObject({ at: z.string() }) }),
]);

export type SnapshotFile =
  { readonly kind: 'absent' } | { readonly kind: 'v2'; readonly state: TemplateState; readonly bytes: Buffer };

export function parseSnapshot(path: string, bytes: Buffer): SnapshotFile {
  let json: unknown;

  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ConfigError(`corrupt state file at ${path}`, { cause: error });
  }

  const version: unknown = typeof json === 'object' && json !== null ? Reflect.get(json, 'version') : undefined;

  if (typeof version === 'number' && Number.isInteger(version) && version > 2) {
    throw new ConfigError(`cannot read the state file at ${path}: ${NEWER}`);
  }

  const parsed = stateV2.safeParse(json);

  if (!parsed.success) {
    throw new ConfigError(`invalid state file at ${path}: ${formatZodError(parsed.error)}`);
  }

  return { kind: 'v2', state: parsed.data, bytes };
}

export interface JournalLine {
  readonly text: string;
  readonly number: number;
  readonly complete: boolean;
}

export function journalLines(raw: string): JournalLine[] {
  const parts = raw.split('\n');

  return parts.flatMap((text, index) =>
    text.trim().length === 0 ? [] : [{ text, number: index + 1, complete: index < parts.length - 1 }],
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function hasHeader(lines: readonly JournalLine[]): boolean {
  const first = lines[0];
  const json = first === undefined ? undefined : parseJson(first.text);

  return typeof json === 'object' && json !== null && Object.hasOwn(json, 'format');
}

export type JournalFile =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'v2';
      readonly bytes: Buffer;
      readonly entries: readonly RecipientJournalEntry[];
      readonly tornTailStart?: number;
    };

export function parseJournal(path: string, bytes: Buffer): JournalFile {
  const raw = bytes.toString('utf8');
  const lines = journalLines(raw);

  if (!hasHeader(lines)) {
    throw new ConfigError(
      `corrupt state journal at ${path}: it does not start with the mailroll journal header; nothing was changed, check the file before running again`,
    );
  }

  const [header, ...rest] = lines;

  if (header?.text !== JOURNAL_HEADER_LINE || !header.complete) {
    throw new ConfigError(`cannot read the state journal at ${path}: ${NEWER}`);
  }

  const entries: RecipientJournalEntry[] = [];

  for (const line of rest) {
    const parsed = entryV2.safeParse(parseJson(line.text));

    if (parsed.success) {
      entries.push(parsed.data);
    } else if (!line.complete) {
      return { kind: 'v2', bytes, entries, tornTailStart: bytes.lastIndexOf(0x0a) + 1 };
    } else {
      throw new ConfigError(`corrupt state journal at ${path} (line ${String(line.number)})`);
    }
  }

  return { kind: 'v2', bytes, entries };
}

export function serializeSnapshot(state: TemplateState): string {
  const checked = stateV2.safeParse(state);

  if (!checked.success) {
    throw new ConfigError(
      `refusing to write a send history mailroll could not read back: ${formatZodError(checked.error)}`,
    );
  }

  return `${JSON.stringify(state, null, 2)}\n`;
}

export function serializeEntry(entry: RecipientJournalEntry): string {
  const checked = entryV2.safeParse(entry);

  if (!checked.success) {
    throw new ConfigError(
      `refusing to write a journal line mailroll could not read back: ${formatZodError(checked.error)}`,
    );
  }

  return `${JSON.stringify(entry)}\n`;
}

export function journalPathFor(statePath: string): string {
  return statePath.endsWith('.json') ? `${statePath}l` : `${statePath}.jsonl`;
}
