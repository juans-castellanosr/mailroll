import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as FsModule from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RecipientJournalEntry } from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { asWriter } from '../../support/write-access';
import { fileNames } from '../../support/history-dir';
import { type ListFiles, listTemplate, type StagedList, stageList } from '../../support/staged-list';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';

const power = vi.hoisted(() => ({ left: Number.POSITIVE_INFINITY, used: [] as string[], readOpened: [] as string[] }));

function boundary(operation: string): void {
  power.used.push(operation);

  if (power.left <= 0) {
    throw new Error(`process killed before ${operation}`);
  }

  power.left -= 1;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromisesModule>();

  type Handle = Awaited<ReturnType<typeof real.open>>;
  const counted = (handle: Handle): Handle =>
    new Proxy(handle, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);

        if (typeof value !== 'function') {
          return value;
        }

        return ['write', 'writeFile', 'truncate'].includes(String(key))
          ? (...args: unknown[]): unknown => {
              boundary(`handle.${String(key)}`);

              return Reflect.apply(value, target, args) as unknown;
            }
          : (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown;
      },
    });

  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const [, flags] = args;
      const writing = flags !== undefined && flags !== 'r';

      if (writing) {
        boundary('open');
      }

      const handle = await real.open(...args);

      if (!writing) {
        power.readOpened.push(String(args[0]));
      }

      return writing ? counted(handle) : handle;
    },
    rename: (...args: Parameters<typeof real.rename>) => {
      boundary('rename');

      return real.rename(...args);
    },
    link: (...args: Parameters<typeof real.link>) => {
      boundary('link');

      return real.link(...args);
    },
    rm: (...args: Parameters<typeof real.rm>) => {
      boundary('rm');

      return real.rm(...args);
    },
    chmod: (...args: Parameters<typeof real.chmod>) => {
      boundary('chmod');

      return real.chmod(...args);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof FsModule>();

  return {
    ...real,
    fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      try {
        boundary('fsync');
      } catch (error) {
        callback(error as NodeJS.ErrnoException);

        return;
      }

      real.fsync(fd, callback);
    },
  };
});

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-history-crash-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const MARK: RecipientJournalEntry = { email: 'nobody@example.com', released: { at: '2026-02-01T00:00:00.000Z' } };
const RETRY_MARK: RecipientJournalEntry = { email: 'retry@example.com', released: { at: '2026-02-02T00:00:00.000Z' } };

async function withPower<T>(
  budget: number,
  work: () => Promise<T>,
): Promise<{ readonly crashed: boolean; readonly boundaries: number }> {
  power.left = budget;
  power.used = [];

  try {
    await work();

    return { crashed: false, boundaries: power.used.length };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('process killed before')) {
      return { crashed: true, boundaries: power.used.length };
    }

    throw error;
  } finally {
    power.left = Number.POSITIVE_INFINITY;
  }
}

async function liveWrite(list: StagedList, write: (store: FileStateStore) => Promise<void>, budget: number) {
  const store = new FileStateStore();
  const lock = await store.lock(list.template);

  await store.load(list.template);

  try {
    return await withPower(budget, () => write(store));
  } finally {
    await lock.release();
  }
}

const V2_SNAPSHOT = `${JSON.stringify(
  {
    version: 2,
    templateId: 'welcome',
    recipients: { 'ana@x.co': { status: 'sent', at: 'T0', connectionId: 'x', attemptId: 'A' } },
    updatedAt: 'T0',
  },
  null,
  2,
)}\n`;
const EVENTS = [
  '{"email":"ben@x.co","intent":{"at":"T1","connectionId":"x","attemptId":"B"}}',
  '{"email":"ben@x.co","status":{"status":"sent","at":"T2","connectionId":"x","attemptId":"B"}}',
];
const COMPLETE_JOURNAL = `${[JOURNAL_HEADER_LINE, ...EVENTS].join('\n')}\n`;

const LAYOUTS: readonly (readonly [string, ListFiles])[] = [
  ['a new list', {}],
  ['a v2 snapshot only', { snapshot: V2_SNAPSHOT }],
  ['a v2 snapshot and a complete journal', { snapshot: V2_SNAPSHOT, journal: COMPLETE_JOURNAL }],
  [
    'a v2 snapshot and a journal without its final newline',
    { snapshot: V2_SNAPSHOT, journal: COMPLETE_JOURNAL.slice(0, -1) },
  ],
  [
    'a v2 snapshot and a journal cut mid-line',
    { snapshot: V2_SNAPSHOT, journal: `${COMPLETE_JOURNAL}{"email":"cam@x.co","sta` },
  ],
];

describe('a run killed at any step of the first write of a list', { timeout: 30_000 }, () => {
  it.each(LAYOUTS)(
    'with %s, always reloads the state it had before the write, and the next live run finishes it',
    async (_label, files) => {
      let budget = 0;
      let crashes = 0;
      let boundaries = 0;

      for (;;) {
        const list = stageList(root, files);
        const expected = await new FileStateStore().load(list.template);
        const attempt = await liveWrite(list, (store) => store.append(list.template, MARK), budget);

        expect(await new FileStateStore().load(list.template)).toEqual(expected);

        await liveWrite(list, (store) => store.append(list.template, RETRY_MARK), Number.POSITIVE_INFINITY);

        expect(await new FileStateStore().load(list.template)).toEqual(expected);
        expect(fileNames(dirname(list.snapshotPath))).toEqual(['list.json', 'list.jsonl']);
        expect(readFileSync(list.journalPath, 'utf8').trimEnd().split('\n').at(-1)).toBe(JSON.stringify(RETRY_MARK));

        if (!attempt.crashed) {
          boundaries = attempt.boundaries;
          break;
        }

        crashes += 1;
        budget += 1;
      }

      expect(boundaries).toBeGreaterThan(0);
      expect(crashes).toBe(boundaries);
    },
  );
});

describe('a run killed while repairing a torn v2 journal', () => {
  it('always reloads the same state and never loses a complete line', async () => {
    const complete = `${JOURNAL_HEADER_LINE}\n{"email":"josé@x.co","status":{"status":"sent","at":"T1","connectionId":"x","attemptId":"Á"}}\n`;
    let budget = 0;

    for (;;) {
      const list = stageList(root, { snapshot: V2_SNAPSHOT, journal: `${complete}{"email":"b@x.co","sta` });
      const expected = await new FileStateStore().load(list.template);
      const { crashed } = await liveWrite(list, (store) => store.append(list.template, MARK), budget);

      expect(await new FileStateStore().load(list.template)).toEqual(expected);
      expect(readFileSync(list.journalPath, 'utf8').startsWith(complete)).toBe(true);

      if (!crashed) {
        expect(readFileSync(list.journalPath, 'utf8')).toBe(`${complete}${JSON.stringify(MARK)}\n`);
        break;
      }

      budget += 1;
    }
  });
});

describe('creating the state folder', () => {
  it('makes every new folder level durable by syncing the parent of each one it created', async () => {
    const top = join(root, 'fresh-campaign');
    const statePath = join(top, '.state', 'nested', 'list.json');

    const template = listTemplate(statePath);
    const store = new FileStateStore();

    power.readOpened = [];
    await asWriter(store, template, () => store.append(template, MARK));

    expect(power.readOpened).toEqual(
      expect.arrayContaining([root, top, join(top, '.state'), join(top, '.state', 'nested')]),
    );
  });
});

describe('a run killed at any step of a v2 compaction', () => {
  it('always reloads the same whole state, updatedAt included, and the next compaction finishes', async () => {
    let budget = 0;
    let crashes = 0;

    for (;;) {
      const list = stageList(root, {});
      const store = new FileStateStore();

      await asWriter(store, list.template, async () => {
        await store.append(list.template, { email: 'a@x.co', intent: { at: 'T1', connectionId: 'x', attemptId: 'A' } });
        await store.append(list.template, {
          email: 'a@x.co',
          status: { status: 'uncertain', at: 'T2', connectionId: 'x', message: 'm', attemptId: 'A' },
        });
        await store.append(list.template, { email: 'b@x.co', intent: { at: 'T3', connectionId: 'x', attemptId: 'B' } });
        await store.append(list.template, {
          email: 'b@x.co',
          status: { status: 'sent', at: 'T4', connectionId: 'x', attemptId: 'B', providerMessageId: 'p-1' },
        });
      });

      const state = await store.load(list.template);
      const { crashed } = await liveWrite(list, (writer) => writer.compact(list.template, state), budget);

      expect(await new FileStateStore().load(list.template)).toEqual(state);

      await liveWrite(list, (writer) => writer.compact(list.template, state), Number.POSITIVE_INFINITY);

      expect(await new FileStateStore().load(list.template)).toEqual(state);
      expect(fileNames(dirname(list.snapshotPath))).toEqual(['list.json']);

      if (!crashed) {
        break;
      }

      crashes += 1;
      budget += 1;
    }

    expect(crashes).toBeGreaterThanOrEqual(5);
  });
});
