import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  type EmailProvider,
  INTERRUPTED_MESSAGE,
  MemoryStateStore,
  type Message,
  parseEmailAddress,
  type Recipient,
  type RecipientJournalEntry,
  type RunMode,
  runTemplate,
  type TemplateState,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';
import { openForWriting } from '../../support/write-access';
import { dirContents } from '../../support/history-dir';
import { type ListFiles, type StagedList, stageList } from '../../support/staged-list';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-history-files-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const C = 'outlook-1';
const MARK: RecipientJournalEntry = { email: 'nobody@example.com', released: { at: '2026-02-01T00:00:00.000Z' } };
const dirOf = (list: StagedList) => dirname(list.snapshotPath);
const TEST_RECIPIENT = (() => {
  const parsed = parseEmailAddress('me@example.com');

  if (!parsed.ok) {
    throw new Error('test setup: bad address');
  }

  return parsed.value;
})();
const V2_SNAPSHOT = `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' }, null, 2)}\n`;
const V2_EVENT = '{"email":"a@x.co","status":{"status":"sent","at":"T1","connectionId":"outlook-1"}}';
const V2_HISTORY: ListFiles = { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n${V2_EVENT}\n` };

async function underLock(list: StagedList, write: (store: FileStateStore) => Promise<void>): Promise<void> {
  const store = new FileStateStore();
  const lock = await store.lock(list.template);

  try {
    await store.load(list.template);
    await write(store);
  } finally {
    await lock.release();
  }
}

function plant(list: StagedList, files: ListFiles): void {
  if (files.snapshot !== undefined) {
    writeFileSync(list.snapshotPath, files.snapshot, { mode: 0o600 });
  }

  if (files.journal !== undefined) {
    writeFileSync(list.journalPath, files.journal, { mode: 0o600 });
  }
}

async function expectRefusal(attempt: Promise<unknown>, message: RegExp): Promise<void> {
  const error: unknown = await attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(ConfigError);
  expect(error).toHaveProperty('message', expect.stringMatching(message));
}

describe('refusing what mailroll cannot safely read or write', () => {
  const INVALID_SNAPSHOT = /invalid state file at .*list\.json: .*version/;
  const MISSING_HEADER = /corrupt state journal at .*list\.jsonl: it does not start with the mailroll journal header/;

  it.each([
    ['a snapshot with version 1', { snapshot: V2_SNAPSHOT.replace('"version": 2', '"version": 1') }, INVALID_SNAPSHOT],
    ['a snapshot with version 0', { snapshot: V2_SNAPSHOT.replace('"version": 2', '"version": 0') }, INVALID_SNAPSHOT],
    ['a snapshot without a version', { snapshot: V2_SNAPSHOT.replace('"version": 2,', '') }, INVALID_SNAPSHOT],
    ['a snapshot that is not an object', { snapshot: '[]\n' }, /invalid state file at .*list\.json/],
    [
      'a journal with no header next to a v2 snapshot',
      { snapshot: V2_SNAPSHOT, journal: `${V2_EVENT}\n` },
      MISSING_HEADER,
    ],
    ['an empty journal next to a v2 snapshot', { snapshot: V2_SNAPSHOT, journal: '' }, MISSING_HEADER],
    ['a whitespace-only journal next to a v2 snapshot', { snapshot: V2_SNAPSHOT, journal: ' \n\n' }, MISSING_HEADER],
    [
      'a v2 journal line with a field mailroll does not know',
      { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n${V2_EVENT.replace('}}', '},"extra":1}')}\n` },
      /corrupt state journal at .*list\.jsonl \(line 2\)/,
    ],
    [
      'a corrupt middle line before a valid last line',
      { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n{"email":"b@x.co","sta\n${V2_EVENT}\n` },
      /corrupt state journal at .*list\.jsonl \(line 2\)/,
    ],
    [
      'a v2 journal whose last complete line is unreadable',
      {
        snapshot: V2_SNAPSHOT,
        journal: `${JOURNAL_HEADER_LINE}\n${V2_EVENT}\n{"email":"b@x.co","status":{"status":"bounced"}}\n`,
      },
      /corrupt state journal at .*list\.jsonl \(line 3\)/,
    ],
    [
      'a journal with no snapshot',
      { journal: `${JOURNAL_HEADER_LINE}\n${V2_EVENT}\n` },
      /the send history at .*list\.json has a journal but no snapshot; nothing was changed/,
    ],
    [
      'a snapshot from a newer mailroll',
      { snapshot: '{"version":3,"recipients":{}}' },
      /cannot read the state file at .*: it was written by a newer mailroll/,
    ],
    [
      'a journal from a newer mailroll',
      { snapshot: V2_SNAPSHOT, journal: '{"format":"mailroll-journal","version":3}\n' },
      /cannot read the state journal at .*: it was written by a newer mailroll/,
    ],
    [
      'a v2 snapshot with a field mailroll does not know',
      { snapshot: V2_SNAPSHOT.replace('"updatedAt"', '"extra": 1, "updatedAt"') },
      /invalid state file at .*list\.json/,
    ],
  ] satisfies [string, ListFiles, RegExp][])(
    'refuses %s on loading, and changes no file',
    async (_label, files, message) => {
      const list = stageList(root, files);
      const before = dirContents(dirOf(list));

      await expectRefusal(new FileStateStore().load(list.template), message);
      await expectRefusal(
        underLock(list, (store) => store.append(list.template, MARK)),
        message,
      );
      expect(dirContents(dirOf(list))).toEqual(before);
    },
  );

  it.each([
    ['a snapshot with version 1', { snapshot: V2_SNAPSHOT.replace('"version": 2', '"version": 1') }, INVALID_SNAPSHOT],
    [
      'a journal with no header next to a v2 snapshot',
      { snapshot: V2_SNAPSHOT, journal: `${V2_EVENT}\n` },
      MISSING_HEADER,
    ],
    ['an empty journal next to a v2 snapshot', { snapshot: V2_SNAPSHOT, journal: '' }, MISSING_HEADER],
    [
      'a v2 journal line with a field mailroll does not know',
      { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n${V2_EVENT.replace('}}', '},"extra":1}')}\n` },
      /corrupt state journal at .*list\.jsonl \(line 2\)/,
    ],
    [
      'a corrupt middle line before a valid last line',
      { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n{"email":"b@x.co","sta\n${V2_EVENT}\n` },
      /corrupt state journal at .*list\.jsonl \(line 2\)/,
    ],
  ] satisfies [string, ListFiles, RegExp][])(
    'refuses %s that appears after the load, on the first live append, and changes no file',
    async (_label, files, message) => {
      const list = stageList(root, {});
      const store = new FileStateStore();
      const lock = await store.lock(list.template);

      try {
        await store.load(list.template);
        plant(list, files);

        const before = dirContents(dirOf(list));

        await expectRefusal(store.append(list.template, MARK), message);
        expect(dirContents(dirOf(list))).toEqual(before);
      } finally {
        await lock.release();
      }
    },
  );
});

describe('reading never writes', () => {
  it.each([
    ['no history', {}],
    ['a v2 snapshot only', { snapshot: V2_SNAPSHOT }],
    ['a v2 snapshot and a journal header', { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n` }],
    [
      'a v2 snapshot and a journal cut mid-line',
      { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n${V2_EVENT}\n{"email":"b@x.co","sta` },
    ],
  ] satisfies [string, ListFiles][])('loads %s without touching a file', async (_label, files) => {
    const list = stageList(root, files);
    const before = dirContents(dirOf(list));

    await new FileStateStore().load(list.template);
    await new FileStateStore().load(list.template);

    expect(dirContents(dirOf(list))).toEqual(before);
  });

  it('ignores a snapshot temp file left by a crash before its rename', async () => {
    const list = stageList(root, V2_HISTORY);
    const expected = await new FileStateStore().load(list.template);

    writeFileSync(`${list.snapshotPath}.0f1e2d3c.tmp`, '{"version": 2, "templateId": "wel');

    expect(await new FileStateStore().load(list.template)).toEqual(expected);
  });

  it.each([
    ['a dry run', { kind: 'dry-run' }],
    ['a test send', { kind: 'test', testRecipient: TEST_RECIPIENT }],
  ] satisfies [string, RunMode][])('runs %s over a v2 history without writing it', async (_label, mode) => {
    const list = stageList(root, V2_HISTORY);
    const before = dirContents(dirOf(list));
    const sent: string[] = [];
    const provider: EmailProvider = {
      send: (message: Message) => {
        sent.push(message.to);

        return Promise.resolve();
      },
    };

    await runTemplate<Recipient>({
      template: list.template,
      source: {
        read: async function* () {
          await Promise.resolve();
          yield { email: 'new@example.com' };
        },
      },
      validator: {
        validate: (record) => {
          const email = parseEmailAddress(record['email'] ?? '');

          return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
        },
      },
      renderer: { render: () => ({ subject: 's', html: '<p>x</p>' }) },
      providers: new Map([[C, provider]]),
      connectionIds: [C],
      policy: { kind: 'pending' },
      mode,
      delayBetweenSendsMs: 0,
      stateStore: new FileStateStore(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      sleeper: { sleep: () => Promise.resolve() },
      now: () => 'NOW',
    });

    expect(sent).toHaveLength(1);
    expect(dirContents(dirOf(list))).toEqual(before);
  });
});

describe('the file store and the memory store', () => {
  const SNAPSHOT: TemplateState = {
    version: 2,
    templateId: 'welcome',
    recipients: {
      'a@x.co': { status: 'sent', at: 'T1', connectionId: C, attemptId: 'A' },
      'b@x.co': { status: 'uncertain', at: 'T2', connectionId: C, message: 'm', attemptId: 'B' },
      'c@x.co': { status: 'failed', at: 'T3', connectionId: C, category: 'transient', message: 'm', attemptId: 'C' },
    },
    updatedAt: 'T3',
  };
  const ENTRIES: readonly RecipientJournalEntry[] = [
    { email: 'a@x.co', intent: { at: 'T4', connectionId: C, attemptId: 'D' } },
    { email: 'c@x.co', intent: { at: 'T5', connectionId: C, attemptId: 'E' } },
    { email: 'c@x.co', status: { status: 'sent', at: 'T6', connectionId: C, attemptId: 'E' } },
    { email: 'b@x.co', intent: { at: 'T7', connectionId: C, attemptId: 'F' } },
    { email: 'b@x.co', released: { at: 'T8' } },
    { email: 'd@x.co', intent: { at: 'T9', connectionId: C } },
  ];

  it('give the same state for the same snapshot and journal', async () => {
    const list = stageList(root, {
      snapshot: `${JSON.stringify(SNAPSHOT, null, 2)}\n`,
      journal: `${[JOURNAL_HEADER_LINE, ...ENTRIES.map((entry) => JSON.stringify(entry))].join('\n')}\n`,
    });
    const memory = new MemoryStateStore();

    await memory.compact(list.template, SNAPSHOT);

    for (const entry of ENTRIES) {
      await memory.append(list.template, entry);
    }

    expect(await new FileStateStore().load(list.template)).toEqual(await memory.load(list.template));
  });
});

describe('a new list', () => {
  it('starts with a v2 snapshot and the journal header before its first entry', async () => {
    const list = stageList(root, {});

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(JSON.parse(readFileSync(list.snapshotPath, 'utf8'))).toMatchObject({ version: 2, recipients: {} });
    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${JSON.stringify(MARK)}\n`);
  });
});

describe('the v2 journal tail', () => {
  const event = '{"email":"a@x.co","status":{"status":"sent","at":"T1","connectionId":"outlook-1","attemptId":"A"}}';

  it('ignores a line cut mid-write when reading, and removes it before writing the next', async () => {
    const list = stageList(root, {
      snapshot: V2_SNAPSHOT,
      journal: `${JOURNAL_HEADER_LINE}\n${event}\n{"email":"b@x.co","sta`,
    });

    expect(Object.keys((await new FileStateStore().load(list.template)).recipients)).toEqual(['a@x.co']);

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${event}\n${JSON.stringify(MARK)}\n`);
  });

  it('keeps a complete last line that only lacks its newline, and adds the newline before writing', async () => {
    const list = stageList(root, { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n${event}` });

    expect(Object.keys((await new FileStateStore().load(list.template)).recipients)).toEqual(['a@x.co']);

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${event}\n${JSON.stringify(MARK)}\n`);
  });
});

describe('the v2 journal with text outside ASCII', () => {
  const lines = [
    '{"email":"josé@x.co","intent":{"at":"T1","connectionId":"outlook-1","attemptId":"Á"}}',
    '{"email":"josé@x.co","status":{"status":"failed","at":"T2","connectionId":"outlook-1","category":"permanent","message":"Buzón lleno — 552 ✉️","attemptId":"Á"}}',
    '{"email":"zoë@x.co","status":{"status":"sent","at":"T3","connectionId":"outlook-1","attemptId":"日本"}}',
  ];

  it('cuts only the torn bytes before writing, keeping every complete line byte for byte', async () => {
    const complete = `${JOURNAL_HEADER_LINE}\n${lines.join('\n')}\n`;
    const list = stageList(root, { snapshot: V2_SNAPSHOT, journal: `${complete}{"email":"ñ@x.co","status":{"sta` });

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${complete}${JSON.stringify(MARK)}\n`);
    expect(Object.keys((await new FileStateStore().load(list.template)).recipients)).toEqual(['josé@x.co', 'zoë@x.co']);
  });
});

describe('a journal that disappears during a run', () => {
  it('prepares the journal again after a compaction whose journal removal failed', async () => {
    const list = stageList(root, {});
    const store = new FileStateStore();
    const lock = await openForWriting(store, list.template);

    await store.append(list.template, MARK);

    const state = await store.load(list.template);

    rmSync(list.journalPath);
    mkdirSync(list.journalPath);
    writeFileSync(join(list.journalPath, 'blocker'), '');

    await expect(store.compact(list.template, state)).rejects.toThrow();

    rmSync(list.journalPath, { recursive: true });

    await store.append(list.template, MARK);
    await lock.release();

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${JSON.stringify(MARK)}\n`);
  });

  it('stops the run instead of starting a journal without its header', async () => {
    const list = stageList(root, {});
    const store = new FileStateStore();
    const lock = await openForWriting(store, list.template);

    await store.append(list.template, MARK);
    rmSync(list.journalPath);

    await expect(store.append(list.template, MARK)).rejects.toThrow(/disappeared during the run; nothing was written/);
    await lock.release();
    expect(existsSync(list.journalPath)).toBe(false);
  });
});

describe('the evidence a v2 history keeps', () => {
  const WITH_EVIDENCE: TemplateState = {
    version: 2,
    templateId: 'welcome',
    recipients: {
      'a@x.co': {
        status: 'sent',
        at: 'T3',
        connectionId: C,
        attemptId: 'C',
        providerMessageId: 'p-1',
        cc: { rejected: ['records@x.co'], required: true },
        uncertainAttemptIds: ['A', 'B'],
      },
      'b@x.co': {
        status: 'sent',
        at: 'T1',
        connectionId: C,
        attemptId: 'D',
        resendFailure: { at: 'T2', connectionId: C, outcome: 'uncertain', message: 'm', attemptId: 'E' },
      },
      'c@x.co': { status: 'failed', at: 'T1', connectionId: C, category: 'permanent', message: 'm', attemptId: 'F' },
    },
    updatedAt: 'T3',
  };

  it('keeps attempt ids, provider ids, rejected CC with their policy and earlier uncertain attempts after compaction and reopening', async () => {
    const list = stageList(root, {});

    await underLock(list, (store) => store.compact(list.template, WITH_EVIDENCE));

    expect(await new FileStateStore().load(list.template)).toEqual(WITH_EVIDENCE);
  });

  it('keeps them in journal lines too', async () => {
    const list = stageList(root, {});

    await underLock(list, async (store) => {
      for (const [email, status] of Object.entries(WITH_EVIDENCE.recipients)) {
        await store.append(list.template, { email, status });
      }
    });

    expect((await new FileStateStore().load(list.template)).recipients).toEqual(WITH_EVIDENCE.recipients);
  });

  it('keeps an earlier intent that a later intent superseded, and its attempt id, when the later one was released', async () => {
    const list = stageList(root, {});

    await underLock(list, async (store) => {
      await store.append(list.template, { email: 'a@x.co', intent: { at: 'T1', connectionId: C, attemptId: 'X' } });
      await store.append(list.template, { email: 'a@x.co', intent: { at: 'T2', connectionId: C, attemptId: 'Y' } });
      await store.append(list.template, { email: 'a@x.co', released: { at: 'T3' } });
    });

    expect((await new FileStateStore().load(list.template)).recipients['a@x.co']).toEqual({
      status: 'uncertain',
      at: 'T1',
      connectionId: C,
      message: INTERRUPTED_MESSAGE,
      attemptId: 'X',
    });
  });

  it('replays a journal left behind by a compaction to exactly the compacted state, updatedAt included', async () => {
    const list = stageList(root, {});
    const store = new FileStateStore();
    const lock = await openForWriting(store, list.template);

    await store.append(list.template, { email: 'a@x.co', intent: { at: 'T1', connectionId: C, attemptId: 'A' } });
    await store.append(list.template, {
      email: 'a@x.co',
      status: { status: 'uncertain', at: 'T2', connectionId: C, message: 'm', attemptId: 'A' },
    });
    await store.append(list.template, { email: 'a@x.co', intent: { at: 'T3', connectionId: C, attemptId: 'B' } });
    await store.append(list.template, {
      email: 'a@x.co',
      status: { status: 'sent', at: 'T4', connectionId: C, attemptId: 'B', uncertainAttemptIds: ['A'] },
    });

    const journal = readFileSync(list.journalPath, 'utf8');
    const state = await store.load(list.template);

    await store.compact(list.template, state);
    await lock.release();
    writeFileSync(list.journalPath, journal);

    expect(await new FileStateStore().load(list.template)).toEqual(state);
    expect(state.updatedAt).toBe('T4');
  });
});
