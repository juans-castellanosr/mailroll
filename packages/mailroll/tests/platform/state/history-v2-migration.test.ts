import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EmailProvider,
  foldJournal,
  INTERRUPTED_MESSAGE,
  type Message,
  parseEmailAddress,
  type Recipient,
  type RecipientJournalEntry,
  type RunMode,
  runTemplate,
  type TemplateState,
  upgradeTemplateState,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';
import { FrozenV1FileStateStore } from '../../support/frozen-v1-file-state-store';
import { openForWriting } from '../../support/write-access';
import { dirContents, fileNames } from '../../support/history-dir';
import { fixture, type ListFiles, type StagedList, stageList } from '../../support/state-v1-fixtures';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-history-v2-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const C = 'outlook-1';
const NOT_LOCKED = /can only be written by the store that holds its lock .*; nothing was written/;
const EVIDENCE = /attemptId|providerMessageId|"cc"|uncertainAttemptIds/;
const MARK: RecipientJournalEntry = { email: 'nobody@example.com', released: { at: '2026-02-01T00:00:00.000Z' } };
const dirOf = (list: StagedList) => dirname(list.snapshotPath);
const TEST_RECIPIENT = (() => {
  const parsed = parseEmailAddress('me@example.com');

  if (!parsed.ok) {
    throw new Error('test setup: bad address');
  }

  return parsed.value;
})();
const v1 = (list: StagedList) => ({ id: list.template.id, statePath: list.snapshotPath });

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

const LAYOUTS: readonly (readonly [string, ListFiles])[] = [
  ['a snapshot and a journal', { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') }],
  ['a snapshot only', { snapshot: fixture('snapshot.json') }],
  ['a journal only', { journal: fixture('journal-mixed.jsonl') }],
  ['a snapshot and an empty journal', { snapshot: fixture('snapshot.json'), journal: '' }],
  [
    'a snapshot and a journal cut mid-line',
    { snapshot: fixture('snapshot.json'), journal: fixture('journal-torn-tail.jsonl') },
  ],
];

describe('upgrading a v1 history in a live run', () => {
  it.each(LAYOUTS)(
    'upgrades %s without losing or inventing anything, and keeps the original bytes',
    async (_label, files) => {
      const list = stageList(root, files);
      const expected = upgradeTemplateState(await new FileStateStore().load(list.template));

      await underLock(list, (store) => store.append(list.template, MARK));

      const snapshot = readFileSync(list.snapshotPath, 'utf8');

      expect(await new FileStateStore().load(list.template)).toEqual(expected);
      expect(JSON.parse(snapshot)).toMatchObject({ version: 2 });
      expect(snapshot).not.toMatch(EVIDENCE);
      expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${JSON.stringify(MARK)}\n`);

      const backups = [
        ...(files.snapshot === undefined ? [] : ['list.json.v1-backup']),
        ...(files.journal === undefined || files.journal === '' ? [] : ['list.jsonl.v1-backup']),
      ];

      expect(fileNames(dirOf(list))).toEqual(['list.json', 'list.jsonl', ...backups].sort());

      if (files.snapshot !== undefined) {
        expect(readFileSync(`${list.snapshotPath}.v1-backup`, 'utf8')).toBe(files.snapshot);
      }

      if (files.journal !== undefined && files.journal !== '') {
        expect(readFileSync(`${list.journalPath}.v1-backup`, 'utf8')).toBe(files.journal);
      }
    },
  );

  it('upgrades through a compaction too, so a live run that sends nothing still leaves a consistent v2 history', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') });
    const expected = upgradeTemplateState(await new FileStateStore().load(list.template));

    await underLock(list, (store) => store.compact(list.template, expected));

    expect(await new FileStateStore().load(list.template)).toEqual(expected);
    expect(fileNames(dirOf(list))).toEqual(['list.json', 'list.json.v1-backup', 'list.jsonl.v1-backup']);
  });

  it('refuses to upgrade without the list lock, and changes nothing', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') });
    const before = dirContents(dirOf(list));
    const store = new FileStateStore();

    await expect(store.append(list.template, MARK)).rejects.toThrow(NOT_LOCKED);
    await expect(store.compact(list.template, upgradeTemplateState(await store.load(list.template)))).rejects.toThrow(
      NOT_LOCKED,
    );
    expect(dirContents(dirOf(list))).toEqual(before);
  });

  it('starts a new list with the v2 barrier before its journal', async () => {
    const list = stageList(root, {});

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(JSON.parse(readFileSync(list.snapshotPath, 'utf8'))).toMatchObject({ version: 2, recipients: {} });
    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${JSON.stringify(MARK)}\n`);
  });

  it('reads an upgrade interrupted after the barrier (v2 snapshot, v1 journal) as the same state, and finishes it later', async () => {
    const files = { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') };
    const list = stageList(root, files);
    const expected = upgradeTemplateState(await new FileStateStore().load(list.template));

    writeFileSync(list.snapshotPath, `${JSON.stringify(foldJournal(expected, []), null, 2)}\n`);

    expect(await new FileStateStore().load(list.template)).toEqual(expected);
    expect(await new FileStateStore().load(list.template)).toEqual(expected);
    await expect(new FrozenV1FileStateStore().load(v1(list))).rejects.toThrow(/invalid state file/);

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(await new FileStateStore().load(list.template)).toEqual(expected);
    expect(readFileSync(`${list.journalPath}.v1-backup`, 'utf8')).toBe(files.journal);
  });
});

describe('refusing what mailroll cannot safely read or write', () => {
  const v2Snapshot = `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' }, null, 2)}\n`;
  const v2Event = '{"email":"a@x.co","status":{"status":"sent","at":"T1","connectionId":"outlook-1"}}';

  it.each([
    [
      'a v2 journal next to a v1 snapshot',
      { snapshot: fixture('snapshot.json'), journal: `${JOURNAL_HEADER_LINE}\n${v2Event}\n` },
      /mixes a v2 journal with a v1 snapshot/,
    ],
    [
      'a v2 journal with no snapshot',
      { journal: `${JOURNAL_HEADER_LINE}\n${v2Event}\n` },
      /mixes a v2 journal with no snapshot/,
    ],
    ['a snapshot from a newer mailroll', { snapshot: '{"version":3,"recipients":{}}' }, /newer mailroll/],
    [
      'a journal from a newer mailroll',
      { snapshot: v2Snapshot, journal: '{"format":"mailroll-journal","version":3}\n' },
      /newer mailroll/,
    ],
    [
      'a v2 snapshot with a field mailroll does not know',
      { snapshot: v2Snapshot.replace('"updatedAt"', '"extra": 1, "updatedAt"') },
      /invalid state file/,
    ],
    [
      'a v2 journal whose last complete line is unreadable',
      {
        snapshot: v2Snapshot,
        journal: `${JOURNAL_HEADER_LINE}\n${v2Event}\n{"email":"b@x.co","status":{"status":"bounced"}}\n`,
      },
      /corrupt state journal .*\(line 3\)/,
    ],
  ])('refuses %s, on reading and on writing, and changes no file', async (_label, files, error) => {
    const list = stageList(root, files);
    const before = dirContents(dirOf(list));

    await expect(new FileStateStore().load(list.template)).rejects.toThrow(error);
    await expect(underLock(list, (store) => store.append(list.template, MARK))).rejects.toThrow(error);
    expect(dirContents(dirOf(list))).toEqual(before);
  });

  it.each([
    ['a complete line it cannot read', fixture('journal-invalid-tail.jsonl')],
    ['fields v1 never wrote', fixture('journal-unknown-fields.jsonl')],
  ])('reads a v1 journal with %s as v1 did, but refuses to upgrade it', async (_label, journal) => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal });
    const before = dirContents(dirOf(list));

    await expect(new FileStateStore().load(list.template)).resolves.toMatchObject({ version: 1 });
    await expect(underLock(list, (store) => store.append(list.template, MARK))).rejects.toThrow(
      /is not a v1 history entry mailroll can keep; nothing was changed/,
    );
    expect(dirContents(dirOf(list))).toEqual(before);
  });

  it('reads a v1 snapshot with fields v1 never wrote as v1 did, but refuses to upgrade it', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot-unknown-fields.json') });
    const before = dirContents(dirOf(list));

    await expect(new FileStateStore().load(list.template)).resolves.toMatchObject({ version: 1 });
    await expect(underLock(list, (store) => store.append(list.template, MARK))).rejects.toThrow(
      /not part of the v1 history format, so upgrading would drop it; nothing was changed/,
    );
    expect(dirContents(dirOf(list))).toEqual(before);
  });

  it('never overwrites an existing backup with other content', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') });

    writeFileSync(`${list.snapshotPath}.v1-backup`, 'something else');

    const before = dirContents(dirOf(list));

    await expect(underLock(list, (store) => store.append(list.template, MARK))).rejects.toThrow(
      /already exists with other content/,
    );
    expect(dirContents(dirOf(list))).toEqual(before);
  });
});

describe('reading never writes', () => {
  it.each([
    ...LAYOUTS,
    [
      'a v2 history',
      {
        snapshot: `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' })}\n`,
        journal: `${JOURNAL_HEADER_LINE}\n`,
      },
    ],
  ] as const)('loads %s without touching a file', async (_label, files) => {
    const list = stageList(root, files);
    const before = dirContents(dirOf(list));

    await new FileStateStore().load(list.template);
    await new FileStateStore().load(list.template);

    expect(dirContents(dirOf(list))).toEqual(before);
  });

  it.each([
    ['a dry run', { kind: 'dry-run' }],
    ['a test send', { kind: 'test', testRecipient: TEST_RECIPIENT }],
  ] satisfies [string, RunMode][])(
    'runs %s over a v1 history without upgrading or writing it',
    async (_label, mode) => {
      const list = stageList(root, { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') });
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
    },
  );
});

describe('the v2 journal tail', () => {
  const v2Snapshot = `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' }, null, 2)}\n`;
  const event = '{"email":"a@x.co","status":{"status":"sent","at":"T1","connectionId":"outlook-1","attemptId":"A"}}';

  it('ignores a line cut mid-write when reading, and removes it before writing the next', async () => {
    const list = stageList(root, {
      snapshot: v2Snapshot,
      journal: `${JOURNAL_HEADER_LINE}\n${event}\n{"email":"b@x.co","sta`,
    });

    expect(Object.keys((await new FileStateStore().load(list.template)).recipients)).toEqual(['a@x.co']);

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${event}\n${JSON.stringify(MARK)}\n`);
  });

  it('keeps a complete last line that only lacks its newline, and adds the newline before writing', async () => {
    const list = stageList(root, { snapshot: v2Snapshot, journal: `${JOURNAL_HEADER_LINE}\n${event}` });

    await underLock(list, (store) => store.append(list.template, MARK));

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${event}\n${JSON.stringify(MARK)}\n`);
  });
});

describe('the v2 journal with text outside ASCII', () => {
  const v2Snapshot = `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' }, null, 2)}\n`;
  const lines = [
    '{"email":"josé@x.co","intent":{"at":"T1","connectionId":"outlook-1","attemptId":"Á"}}',
    '{"email":"josé@x.co","status":{"status":"failed","at":"T2","connectionId":"outlook-1","category":"permanent","message":"Buzón lleno — 552 ✉️","attemptId":"Á"}}',
    '{"email":"zoë@x.co","status":{"status":"sent","at":"T3","connectionId":"outlook-1","attemptId":"日本"}}',
  ];

  it('cuts only the torn bytes before writing, keeping every complete line byte for byte', async () => {
    const complete = `${JOURNAL_HEADER_LINE}\n${lines.join('\n')}\n`;
    const list = stageList(root, { snapshot: v2Snapshot, journal: `${complete}{"email":"ñ@x.co","status":{"sta` });

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

    const state = upgradeTemplateState(await store.load(list.template));

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
    const state = upgradeTemplateState(await store.load(list.template));

    await store.compact(list.template, state);
    await lock.release();
    writeFileSync(list.journalPath, journal);

    expect(await new FileStateStore().load(list.template)).toEqual(state);
    expect(state.updatedAt).toBe('T4');
  });
});

describe('restoring the v1 files by hand (only when no v2 event exists)', () => {
  it('gives the published v1 reader back exactly the history it had', async () => {
    const files = { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') };
    const list = stageList(root, files);
    const original = await new FrozenV1FileStateStore().load(v1(list));
    const migrated = upgradeTemplateState(await new FileStateStore().load(list.template));

    await underLock(list, (store) => store.compact(list.template, migrated));

    expect(existsSync(list.journalPath)).toBe(false);
    expect((await new FileStateStore().load(list.template)).recipients).toEqual(
      foldJournal(upgradeTemplateState(original), []).recipients,
    );

    renameSync(list.snapshotPath, `${list.snapshotPath}.v2-abandoned`);
    renameSync(`${list.snapshotPath}.v1-backup`, list.snapshotPath);
    renameSync(`${list.journalPath}.v1-backup`, list.journalPath);

    expect(readFileSync(list.snapshotPath, 'utf8')).toBe(files.snapshot);
    expect(readFileSync(list.journalPath, 'utf8')).toBe(files.journal);
    expect(await new FrozenV1FileStateStore().load(v1(list))).toEqual(original);
  });
});
