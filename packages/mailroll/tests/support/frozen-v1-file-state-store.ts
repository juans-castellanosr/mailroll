import { randomUUID } from 'node:crypto';
import { fsync } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const fsyncDescriptor = promisify(fsync);

const failureCategory = z.enum(['transient', 'permanent', 'auth', 'throttled']);
const resendFailureSchema = z.object({
  at: z.string(),
  connectionId: z.string(),
  outcome: z.enum(['failed', 'uncertain']),
  message: z.string(),
  category: failureCategory.exactOptional(),
});
const statusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('sent'),
    at: z.string(),
    connectionId: z.string(),
    resendFailure: resendFailureSchema.exactOptional(),
  }),
  z.object({
    status: z.literal('failed'),
    at: z.string(),
    connectionId: z.string(),
    category: failureCategory,
    message: z.string(),
  }),
  z.object({
    status: z.literal('uncertain'),
    at: z.string(),
    connectionId: z.string(),
    message: z.string(),
    resendFailure: resendFailureSchema.exactOptional(),
  }),
]);
const stateSchema = z.object({
  version: z.literal(1),
  templateId: z.string(),
  recipients: z.record(z.string(), statusSchema),
  updatedAt: z.string(),
});
const journalEntrySchema = z.union([
  z.object({ email: z.string(), status: statusSchema }),
  z.object({ email: z.string(), intent: z.object({ at: z.string(), connectionId: z.string() }) }),
  z.object({ email: z.string(), released: z.object({ at: z.string() }) }),
]);

export type FrozenV1Status = z.infer<typeof statusSchema>;
export type FrozenV1State = z.infer<typeof stateSchema>;
export type FrozenV1Entry = z.infer<typeof journalEntrySchema>;

export interface FrozenV1List {
  readonly id: string;
  readonly statePath: string;
}

const INTERRUPTED = 'the run ended before the outcome of this send was recorded (crash, kill or power loss)';

function settleV1(previous: FrozenV1Status | undefined, next: FrozenV1Status): FrozenV1Status {
  if (previous === undefined || previous.status === 'failed' || next.status === 'sent') {
    return next;
  }

  if (previous.status === 'uncertain' && next.status === 'uncertain') {
    return next;
  }

  return {
    ...previous,
    resendFailure: {
      at: next.at,
      connectionId: next.connectionId,
      outcome: next.status,
      message: next.message,
      ...(next.status === 'failed' ? { category: next.category } : {}),
    },
  };
}

function journalPathFor(statePath: string): string {
  return statePath.endsWith('.json') ? `${statePath}l` : `${statePath}.jsonl`;
}

function parseJournalLine(line: string): FrozenV1Entry | undefined {
  let json: unknown;

  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }

  const parsed = journalEntrySchema.safeParse(json);

  return parsed.success ? parsed.data : undefined;
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');

  try {
    await fsyncDescriptor(handle.fd);
  } finally {
    await handle.close();
  }
}

export class FrozenV1FileStateStore {
  private readonly checkedJournals = new Set<string>();

  async load(list: FrozenV1List): Promise<FrozenV1State> {
    let snapshot: FrozenV1State = {
      version: 1,
      templateId: list.id,
      recipients: {},
      updatedAt: new Date(0).toISOString(),
    };
    let raw: string | undefined;

    try {
      raw = await readFile(list.statePath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }

    if (raw !== undefined) {
      let json: unknown;

      try {
        json = JSON.parse(raw);
      } catch (error) {
        throw new Error(`corrupt state file at ${list.statePath}`, { cause: error });
      }

      const parsed = stateSchema.safeParse(json);

      if (!parsed.success) {
        throw new Error(`invalid state file at ${list.statePath}`);
      }

      snapshot = parsed.data;
    }

    return this.replay(list, snapshot);
  }

  async append(list: FrozenV1List, entry: FrozenV1Entry): Promise<void> {
    const path = journalPathFor(list.statePath);

    await mkdir(dirname(path), { recursive: true });

    if (!this.checkedJournals.has(path)) {
      await repairTruncatedTail(path);
    }

    const handle = await open(path, 'a', 0o600);

    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await fsyncDescriptor(handle.fd);
    } finally {
      await handle.close();
    }

    this.checkedJournals.add(path);
  }

  async compact(list: FrozenV1List, state: FrozenV1State): Promise<void> {
    const path = list.statePath;
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);

    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await fsyncDescriptor(handle.fd);
    } finally {
      await handle.close();
    }

    await rename(tmp, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
    await rm(journalPathFor(path), { force: true });
    this.checkedJournals.delete(journalPathFor(path));
  }

  private async replay(list: FrozenV1List, snapshot: FrozenV1State): Promise<FrozenV1State> {
    const path = journalPathFor(list.statePath);
    let raw: string;

    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return snapshot;
      }

      throw error;
    }

    const lines = raw.split('\n');
    const recipients: Record<string, FrozenV1Status> = { ...snapshot.recipients };
    const openIntents = new Map<string, { at: string; connectionId: string }>();
    let updatedAt = snapshot.updatedAt;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (line === undefined || line.trim().length === 0) {
        continue;
      }

      const entry = parseJournalLine(line);

      if (entry === undefined) {
        if (lines.slice(i + 1).every((next) => next.trim().length === 0)) {
          break;
        }

        throw new Error(`corrupt state journal at ${path} (line ${String(i + 1)})`);
      }

      if ('status' in entry) {
        recipients[entry.email] = entry.status;
        openIntents.delete(entry.email);
        updatedAt = entry.status.at;
      } else if ('intent' in entry) {
        openIntents.set(entry.email, entry.intent);
      } else {
        openIntents.delete(entry.email);
      }
    }

    for (const [email, intent] of openIntents) {
      recipients[email] = settleV1(recipients[email], {
        status: 'uncertain',
        at: intent.at,
        connectionId: intent.connectionId,
        message: INTERRUPTED,
      });
    }

    return { ...snapshot, recipients, updatedAt };
  }
}

async function repairTruncatedTail(path: string): Promise<void> {
  let size: number;

  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  if (size === 0) {
    return;
  }

  const content = await readFile(path);

  if (content[content.length - 1] === 0x0a) {
    return;
  }

  const lineStart = content.lastIndexOf(0x0a) + 1;

  if (parseJournalLine(content.subarray(lineStart).toString('utf8')) !== undefined) {
    await appendFile(path, '\n');

    return;
  }

  await truncate(path, lineStart);
}
