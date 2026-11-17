import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EmailAddress,
  INTERRUPTED_MESSAGE,
  MemoryStateStore,
  parseEmailAddress,
  planRun,
  type RecipientJournalEntry,
  type ResendPolicy,
  type TemplateStateV1,
  upgradeTemplateState,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { countList, describeStatus, formatCounts, type ListStatus } from '../../../src/platform/status/list-status';
import { expectPrivateFile } from '../../support/private-file';
import { fixture, listTemplate, stageList } from '../../support/state-v1-fixtures';
import { FrozenV1FileStateStore } from '../../support/frozen-v1-file-state-store';
import { describeV1ReaderSafety } from '../../support/v1-reader-safety';

let root: string;

beforeAll(() => {
  root = mkdtempSync(`${tmpdir()}/mailroll-history-v1-`);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const C = 'outlook-1';
const interrupted = (at: string) => ({
  at,
  connectionId: C,
  outcome: 'uncertain' as const,
  message: INTERRUPTED_MESSAGE,
});

const MIXED: TemplateStateV1 = {
  version: 1,
  templateId: 'welcome',
  recipients: {
    'ana@example.com': {
      status: 'sent',
      at: '2026-01-10T10:00:00.000Z',
      connectionId: C,
      resendFailure: interrupted('2026-01-15T10:00:02.000Z'),
    },
    'ben@example.com': {
      status: 'sent',
      at: '2026-01-10T10:00:01.000Z',
      connectionId: C,
      resendFailure: interrupted('2026-01-15T10:00:11.000Z'),
    },
    'cam@example.com': { status: 'sent', at: '2026-01-15T10:00:01.000Z', connectionId: C },
    'dan@example.com': {
      status: 'uncertain',
      at: '2026-01-15T10:00:03.000Z',
      connectionId: C,
      message: INTERRUPTED_MESSAGE,
    },
    'eva@example.com': {
      status: 'uncertain',
      at: '2026-01-15T10:00:04.000Z',
      connectionId: C,
      message: INTERRUPTED_MESSAGE,
    },
    'fay@example.com': {
      status: 'uncertain',
      at: '2026-01-15T10:00:07.000Z',
      connectionId: C,
      message: INTERRUPTED_MESSAGE,
    },
    'gus@example.com': {
      status: 'uncertain',
      at: '2026-01-15T10:00:08.000Z',
      connectionId: C,
      message: INTERRUPTED_MESSAGE,
    },
    'hal@example.com': {
      status: 'failed',
      at: '2026-01-15T10:00:10.000Z',
      connectionId: C,
      category: 'transient',
      message: 'Graph timeout',
    },
  },
  updatedAt: '2026-01-15T10:00:10.000Z',
};

const laterSend: RecipientJournalEntry = {
  email: 'lia@example.com',
  status: { status: 'sent', at: '2026-01-15T12:00:00.000Z', connectionId: C },
};

function address(raw: string): EmailAddress {
  const parsed = parseEmailAddress(raw);

  if (!parsed.ok) {
    throw new Error(`fixture address ${raw} is invalid`);
  }

  return parsed.value;
}

const LIST = ['ana', 'ben', 'cam', 'dan', 'eva', 'fay', 'gus', 'hal', 'jon', 'kim'].map((name) =>
  address(`${name}@example.com`),
);

function journalEntries(name: string): RecipientJournalEntry[] {
  return fixture(name)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecipientJournalEntry);
}

const v1 = (list: { readonly template: { readonly id: string }; readonly snapshotPath: string }) => ({
  id: list.template.id,
  statePath: list.snapshotPath,
});

async function compactWithV1Writer(
  store: FrozenV1FileStateStore,
  list: ReturnType<typeof v1>,
  state: TemplateStateV1,
): Promise<void> {
  const compaction = store.compact(list, state);

  if (process.platform === 'win32') {
    await expect(compaction).rejects.toMatchObject({ code: 'EPERM', syscall: 'fsync' });

    return;
  }

  await compaction;
}

const mixedList = () =>
  stageList(root, { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') });

describe('v1 history: loading', () => {
  it('replays the journal over the snapshot exactly', async () => {
    expect(await new FileStateStore().load(mixedList().template)).toEqual(MIXED);
  });

  it('loads the snapshot alone unchanged', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json') });

    expect(await new FileStateStore().load(list.template)).toEqual(JSON.parse(fixture('snapshot.json')));
  });

  it('gives the same state in the memory store for the same snapshot and journal', async () => {
    const memory = new MemoryStateStore();
    const { template } = mixedList();

    await memory.compact(template, upgradeTemplateState(JSON.parse(fixture('snapshot.json')) as TemplateStateV1));

    for (const entry of journalEntries('journal-mixed.jsonl')) {
      await memory.append(template, entry);
    }

    expect(await memory.load(template)).toEqual(upgradeTemplateState(await new FileStateStore().load(template)));
  });

  it('never writes while loading', async () => {
    const list = mixedList();

    await new FileStateStore().load(list.template);

    expect(readFileSync(list.snapshotPath, 'utf8')).toBe(fixture('snapshot.json'));
    expect(readFileSync(list.journalPath, 'utf8')).toBe(fixture('journal-mixed.jsonl'));
  });
});

describe('v1 history: journal tail and corruption', () => {
  it('ignores a last line cut off mid-write', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal: fixture('journal-torn-tail.jsonl') });

    expect(await new FileStateStore().load(list.template)).toEqual(MIXED);
  });

  it('reads a complete last line that lacks its newline', async () => {
    const list = stageList(root, { journal: fixture('journal-no-newline.jsonl') });

    expect((await new FileStateStore().load(list.template)).recipients).toEqual({
      'kim@example.com': { status: 'sent', at: '2026-01-15T11:00:01.000Z', connectionId: C },
    });
  });

  it('stops at an unreadable line that is not the last', async () => {
    const list = stageList(root, { journal: fixture('journal-corrupt-middle.jsonl') });

    await expect(new FileStateStore().load(list.template)).rejects.toThrow(
      /corrupt state journal at .*list\.jsonl \(line 2\)/,
    );
  });

  it('ignores a complete but invalid last line, which turns fatal after the next append (latent v1 defect)', async () => {
    const list = stageList(root, {
      snapshot: fixture('snapshot.json'),
      journal: fixture('journal-invalid-tail.jsonl'),
    });

    expect(await new FileStateStore().load(list.template)).toEqual(MIXED);

    await new FrozenV1FileStateStore().append(v1(list), laterSend);

    await expect(new FileStateStore().load(list.template)).rejects.toThrow(/\(line 13\)/);
  });
});

describe('v1 history: an intent superseded by a later intent (fixed in F1; v1 dropped it)', () => {
  const journal = [
    '{"email":"fay@example.com","intent":{"at":"2026-01-15T10:00:00.000Z","connectionId":"outlook-1"}}',
    '{"email":"fay@example.com","intent":{"at":"2026-01-15T11:00:00.000Z","connectionId":"outlook-1"}}',
    '{"email":"fay@example.com","released":{"at":"2026-01-15T11:00:01.000Z"}}',
    '',
  ].join('\n');

  it('loads the recipient as uncertain from the first intent, whose outcome was never recorded', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal });

    expect((await new FileStateStore().load(list.template)).recipients['fay@example.com']).toEqual({
      status: 'uncertain',
      at: '2026-01-15T10:00:00.000Z',
      connectionId: C,
      message: INTERRUPTED_MESSAGE,
    });
  });

  it('holds that recipient instead of sending it again', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json'), journal });
    const state = upgradeTemplateState(await new FileStateStore().load(list.template));
    const plan = planRun({
      recipients: [address('fay@example.com')],
      state,
      policy: { kind: 'pending' },
      connectionIds: [C],
    });

    expect(plan.assignments).toEqual([]);
    expect(plan.skipped.map((skip) => skip.code)).toEqual(['held-uncertain']);
  });
});

describe('v1 history: unknown fields', () => {
  it('drops fields it does not know when loading, and the v1 compaction erased them from disk (C3)', async () => {
    const list = stageList(root, {
      snapshot: fixture('snapshot-unknown-fields.json'),
      journal: fixture('journal-unknown-fields.jsonl'),
    });
    const state = await new FileStateStore().load(list.template);

    expect(state).toEqual({
      version: 1,
      templateId: 'welcome',
      recipients: {
        'lia@example.com': { status: 'sent', at: '2026-01-10T10:00:00.000Z', connectionId: C },
        'kim@example.com': { status: 'sent', at: '2026-01-15T11:00:01.000Z', connectionId: C },
      },
      updatedAt: '2026-01-15T11:00:01.000Z',
    });

    const frozen = new FrozenV1FileStateStore();

    await compactWithV1Writer(frozen, v1(list), await frozen.load(v1(list)));

    const written = readFileSync(list.snapshotPath, 'utf8');

    expect(written).not.toMatch(/attemptId|providerMessageId|migratedBy|note/);
  });
});

describe('v1 history: compaction by the 0.1.0 writer, and crashes around it', () => {
  it('writes the snapshot as 2-space JSON with a final newline and mode 0600, and removes the journal where the folder flush succeeds', async () => {
    const list = mixedList();

    await compactWithV1Writer(new FrozenV1FileStateStore(), v1(list), MIXED);

    expect(readFileSync(list.snapshotPath, 'utf8')).toBe(`${JSON.stringify(MIXED, null, 2)}\n`);
    expect(readdirSync(dirname(list.snapshotPath)).sort()).toEqual(
      process.platform === 'win32'
        ? [basename(list.snapshotPath), basename(list.journalPath)].sort()
        : [basename(list.snapshotPath)],
    );

    expectPrivateFile(list.snapshotPath);
  });

  it('is unaffected by a compaction temp file left by a crash before the rename', async () => {
    const list = mixedList();

    writeFileSync(`${list.snapshotPath}.0f1e2d3c.tmp`, '{"version": 1, "templateId": "wel');

    expect(await new FileStateStore().load(list.template)).toEqual(MIXED);
  });

  it('replays to the same recipients when a crash leaves the journal behind a compacted snapshot (fold is idempotent)', async () => {
    const list = mixedList();
    const store = new FrozenV1FileStateStore();
    const folded = await store.load(v1(list));

    await compactWithV1Writer(store, v1(list), folded);
    writeFileSync(list.journalPath, fixture('journal-mixed.jsonl'));

    expect(await new FileStateStore().load(list.template)).toEqual(folded);
  });

  it('takes updatedAt back to the last journal outcome when that journal is replayed again', async () => {
    const list = mixedList();
    const store = new FrozenV1FileStateStore();
    const folded = await store.load(v1(list));

    await compactWithV1Writer(store, v1(list), { ...folded, updatedAt: '2026-01-16T00:00:00.000Z' });
    writeFileSync(list.journalPath, fixture('journal-mixed.jsonl'));

    const replayed = await new FileStateStore().load(list.template);

    expect(replayed.recipients).toEqual(folded.recipients);
    expect(replayed.updatedAt).toBe('2026-01-15T10:00:10.000Z');
  });
});

describe('v1 history: what the next run plans from it', () => {
  const planned = (policy: ResendPolicy) => {
    const plan = planRun({ recipients: LIST, state: upgradeTemplateState(MIXED), policy, connectionIds: [C] });

    return {
      send: plan.assignments.map((assignment) => assignment.recipient),
      skipped: plan.skipped.map((skip) => [skip.identifier, skip.code]),
    };
  };

  it('pending sends the failed and the new, and holds every uncertain', () => {
    expect(planned({ kind: 'pending' })).toEqual({
      send: ['hal@example.com', 'jon@example.com', 'kim@example.com'],
      skipped: [
        ['ana@example.com', 'already-sent'],
        ['ben@example.com', 'already-sent'],
        ['cam@example.com', 'already-sent'],
        ['dan@example.com', 'held-uncertain'],
        ['eva@example.com', 'held-uncertain'],
        ['fay@example.com', 'held-uncertain'],
        ['gus@example.com', 'held-uncertain'],
      ],
    });
  });

  it('failed-only sends the failed and holds every uncertain', () => {
    expect(planned({ kind: 'failed-only' })).toEqual({
      send: ['hal@example.com'],
      skipped: [
        ['ana@example.com', 'not-failed'],
        ['ben@example.com', 'not-failed'],
        ['cam@example.com', 'not-failed'],
        ['dan@example.com', 'held-uncertain'],
        ['eva@example.com', 'held-uncertain'],
        ['fay@example.com', 'held-uncertain'],
        ['gus@example.com', 'held-uncertain'],
        ['jon@example.com', 'not-failed'],
        ['kim@example.com', 'not-failed'],
      ],
    });
  });

  it('force-all sends everyone, and subset sends exactly the requested', () => {
    expect(planned({ kind: 'force-all' })).toEqual({ send: LIST, skipped: [] });
    expect(
      planned({
        kind: 'subset',
        recipients: [address('hal@example.com'), address('dan@example.com'), address('zed@example.com')],
      }),
    ).toEqual({
      send: ['dan@example.com', 'hal@example.com'],
      skipped: [
        ['ana@example.com', 'not-selected'],
        ['ben@example.com', 'not-selected'],
        ['cam@example.com', 'not-selected'],
        ['eva@example.com', 'not-selected'],
        ['fay@example.com', 'not-selected'],
        ['gus@example.com', 'not-selected'],
        ['jon@example.com', 'not-selected'],
        ['kim@example.com', 'not-selected'],
        ['zed@example.com', 'not-in-list'],
      ],
    });
  });
});

describe('v1 history: what status shows from it', () => {
  const list: ListStatus = {
    template: listTemplate('unused.json'),
    dataFile: 'list.csv',
    recipients: LIST,
    rejected: [],
    state: upgradeTemplateState(MIXED),
    fingerprint: 'unused',
  };

  it('counts per list', () => {
    expect(countList(list)).toEqual({
      total: 10,
      sent: 3,
      failed: 1,
      uncertain: 4,
      pending: 3,
      rejected: 0,
      ccRejectedMessages: 0,
      requiredCcRejectedMessages: 0,
    });
    expect(formatCounts(countList(list))).toBe('10 in list · sent 3 · failed 1 · pending 3 · uncertain 4');
  });

  it('describes each recipient', () => {
    const recipients = MIXED.recipients;
    const snapshotOnly = JSON.parse(fixture('snapshot.json')) as TemplateStateV1;

    expect(describeStatus(recipients['ana@example.com'])).toBe('sent 2026-01-10 (a later resend is uncertain)');
    expect(describeStatus(snapshotOnly.recipients['ben@example.com'])).toBe('sent 2026-01-10 (a later resend failed)');
    expect(describeStatus(recipients['cam@example.com'])).toBe('sent 2026-01-15');
    expect(describeStatus(recipients['dan@example.com'])).toBe(
      'UNCERTAIN 2026-01-15 — may have been delivered; check before resending',
    );
    expect(describeStatus(recipients['hal@example.com'])).toBe('failed 2026-01-15 (transient)');
    expect(describeStatus(recipients['jon@example.com'])).toBe('not sent yet');
  });
});

describeV1ReaderSafety(() => root);
