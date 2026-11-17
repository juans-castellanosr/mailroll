import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, StatePersistenceError, TemplateRunError, upgradeTemplateState } from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE, serializeSnapshot } from '../../../src/platform/state/history-format';
import { Checkpoints } from '../../support/concurrency/barrier';
import { interleaver } from '../../support/concurrency/fs-interleave';
import { type ListFixture, listAt, runList, runLocked } from '../../support/concurrency/list-run';
import { preparedLedgerSender, SendLedger } from '../../support/concurrency/send-ledger';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const { interleaver: hooks } = await import('../../support/concurrency/fs-interleave');

  return { ...actual, open: hooks.wrap('open', 1, actual.open) };
});

const ADA = 'ada@example.com';
const GRACE = 'grace@example.com';
const ALAN = 'alan@example.org';
const SNAPSHOT_TEMPORARY = /^recipients\.json\.[0-9a-f-]{36}\.tmp$/;
const V1_SNAPSHOT = `${JSON.stringify({ version: 1, templateId: 'welcome', recipients: {}, updatedAt: 'T0' })}\n`;

let dir: string;
let statePath: string;
let listOfA: ListFixture;
let listOfB: ListFixture;
let ledger: SendLedger;
let checkpoints: Checkpoints;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-lost-lock-rewrites-'));
  statePath = join(dir, '.state', 'recipients.json');
  listOfA = listAt(statePath, [ADA, GRACE]);
  listOfB = listAt(statePath, [ADA, GRACE, ALAN]);
  ledger = new SendLedger(join(dir, 'calls.jsonl'));
  checkpoints = new Checkpoints();
  interleaver.reset();
  mkdirSync(dirname(statePath), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gateOf(run: string): (to: string) => Promise<void> {
  return (to) => {
    const name = `${run}:${to}`;

    return checkpoints.isWatched(name) ? checkpoints.arrive(name) : Promise.resolve();
  };
}

function settled(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function persistenceErrorOf(error: unknown): StatePersistenceError | undefined {
  const cause = error instanceof TemplateRunError ? error.cause : error;

  return cause instanceof StatePersistenceError ? cause : undefined;
}

interface RunA {
  readonly finished: Promise<unknown>;
}

async function startA(): Promise<RunA> {
  const sender = await preparedLedgerSender({ ledger, run: 'A', policy: 'pending' });
  const finished = settled(
    interleaver.as('A', () =>
      runLocked({ list: listOfA, store: new FileStateStore(), senders: new Map([['outlook-1', sender]]) }),
    ),
  );

  return { finished };
}

interface RunB {
  readonly finished: Promise<unknown>;
  readonly release: () => Promise<void>;
}

async function startB(): Promise<RunB> {
  const sender = await preparedLedgerSender({ ledger, run: 'B', policy: 'pending', gate: gateOf('B') });
  const store = new FileStateStore();
  const lock = await store.lock(listOfB.template);
  const finished = settled(runList({ list: listOfB, store, senders: new Map([['outlook-1', sender]]) }));

  return { finished, release: () => lock.release() };
}

async function runAfter(): Promise<void> {
  const sender = await preparedLedgerSender({ ledger, run: 'after', policy: 'pending' });

  await runLocked({ list: listOfB, store: new FileStateStore(), senders: new Map([['outlook-1', sender]]) });
}

async function statusesOnDisk(): Promise<Readonly<Record<string, string>>> {
  const recipients = upgradeTemplateState(await new FileStateStore().load(listOfB.template)).recipients;

  return Object.fromEntries(Object.entries(recipients).map(([email, status]) => [email, status.status]));
}

function seed(snapshot: string, journal?: string): void {
  writeFileSync(statePath, snapshot, { mode: 0o600 });

  if (journal !== undefined) {
    writeFileSync(`${statePath.slice(0, -'.json'.length)}.jsonl`, journal, { mode: 0o600 });
  }
}

const EMPTY_V2 = serializeSnapshot(emptyState('welcome'));
const lockPath = (): string => `${statePath}.lock`;

describe('a run whose lock is deleted while it compacts its history', () => {
  it('does not replace the snapshot of a run that took the list, sent an extra row and finished meanwhile', async () => {
    seed(EMPTY_V2);

    const beforeSnapshot = interleaver.pauseBefore('A', 'open', 1, (file) => SNAPSHOT_TEMPORARY.test(file));
    const a = await startA();

    await interleaver.reached(beforeSnapshot);
    rmSync(lockPath());

    const b = await startB();
    const failureOfB = await b.finished;

    await b.release();
    interleaver.release(beforeSnapshot);

    const failureOfA = persistenceErrorOf(await a.finished);

    await runAfter();

    expect(failureOfB).toBeUndefined();
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
    expect(ledger.calls().filter((call) => call.run === 'after')).toEqual([]);
    expect(await statusesOnDisk()).toEqual({ [ADA]: 'sent', [GRACE]: 'sent', [ALAN]: 'sent' });
    expect(failureOfA?.message).toMatch(/^could not record send state snapshot; /);
    expect(failureOfA?.message).toContain('(its lock file no longer belongs to this run); nothing was written');
  });

  it('does not replace the snapshot or remove the journal while a run that took the list is still sending', async () => {
    seed(EMPTY_V2);
    checkpoints.watch(`B:${ALAN}`);

    const beforeSnapshot = interleaver.pauseBefore('A', 'open', 1, (file) => SNAPSHOT_TEMPORARY.test(file));
    const a = await startA();

    await interleaver.reached(beforeSnapshot);
    rmSync(lockPath());

    const b = await startB();

    await Promise.race([checkpoints.reached(`B:${ALAN}`), b.finished]);
    interleaver.release(beforeSnapshot);

    const failureOfA = persistenceErrorOf(await a.finished);

    checkpoints.release(`B:${ALAN}`);

    const failureOfB = await b.finished;

    await b.release();
    await runAfter();

    expect(failureOfB).toBeUndefined();
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
    expect(ledger.calls().filter((call) => call.run === 'after')).toEqual([]);
    expect(failureOfA?.message).toMatch(/^could not record send state snapshot; /);
  });

  it('keeps the journal when the lock is lost between the new snapshot and the removal of the journal', async () => {
    seed(EMPTY_V2);
    checkpoints.watch(`B:${ALAN}`);

    const beforeSnapshot = interleaver.pauseBefore('A', 'open', 1, (file) => SNAPSHOT_TEMPORARY.test(file));
    const a = await startA();

    await interleaver.reached(beforeSnapshot);

    const afterSnapshot = interleaver.pauseBefore('A', 'open', 1, (file) => file === '.state');

    interleaver.release(beforeSnapshot);
    await interleaver.reached(afterSnapshot);
    rmSync(lockPath());

    const b = await startB();

    await Promise.race([checkpoints.reached(`B:${ALAN}`), b.finished]);
    interleaver.release(afterSnapshot);

    const failureOfA = persistenceErrorOf(await a.finished);

    checkpoints.release(`B:${ALAN}`);

    const failureOfB = await b.finished;

    await b.release();
    await runAfter();

    expect(failureOfB).toBeUndefined();
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
    expect(ledger.calls().filter((call) => call.run === 'after')).toEqual([]);
    expect(failureOfA?.message).toMatch(/^could not record send state snapshot; /);
    expect(failureOfA?.message).toContain(
      'was written, but right after it this run could no longer confirm that it holds its lock (its lock file no longer belongs to this run); the journal was kept',
    );
  });
});

describe('a run whose lock is deleted while it prepares the history for its first write', () => {
  it('does not cut off the lines that a run which took the list appended after the same torn tail', async () => {
    seed(EMPTY_V2, `${JOURNAL_HEADER_LINE}\n{"email":"torn@example.com","sta`);
    checkpoints.watch(`B:${ALAN}`);

    const beforeRepair = interleaver.pauseBefore('A', 'open', 1, (file) => file === 'recipients.jsonl');
    const a = await startA();

    await interleaver.reached(beforeRepair);
    rmSync(lockPath());

    const b = await startB();

    await Promise.race([checkpoints.reached(`B:${ALAN}`), b.finished]);
    interleaver.release(beforeRepair);

    const failureOfA = persistenceErrorOf(await a.finished);
    const whileBSends = await statusesOnDisk();

    checkpoints.release(`B:${ALAN}`);

    const failureOfB = await b.finished;

    await b.release();
    await runAfter();

    expect(whileBSends).toEqual({ [ADA]: 'sent', [GRACE]: 'sent', [ALAN]: 'uncertain' });
    expect(failureOfB).toBeUndefined();
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
    expect(ledger.calls().filter((call) => call.run === 'A')).toEqual([]);
    expect(failureOfA?.message).toMatch(/^could not record send state before sending to ada@example\.com; /);
    expect(failureOfA?.message).toContain(
      'while preparing the history files this run could no longer confirm that it holds it',
    );
  });

  it('does not overwrite, with its upgrade of a v1 snapshot, the history of a run that took the list and finished', async () => {
    seed(V1_SNAPSHOT);

    const beforeUpgrade = interleaver.pauseBefore('A', 'open', 1, (file) => SNAPSHOT_TEMPORARY.test(file));
    const a = await startA();

    await interleaver.reached(beforeUpgrade);
    rmSync(lockPath());

    const b = await startB();
    const failureOfB = await b.finished;

    await b.release();
    interleaver.release(beforeUpgrade);

    const failureOfA = persistenceErrorOf(await a.finished);

    await runAfter();

    expect(failureOfB).toBeUndefined();
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
    expect(ledger.calls().filter((call) => call.run === 'A' || call.run === 'after')).toEqual([]);
    expect(await statusesOnDisk()).toEqual({ [ADA]: 'sent', [GRACE]: 'sent', [ALAN]: 'sent' });
    expect(failureOfA?.message).toMatch(/^could not record send state before sending to ada@example\.com; /);
    expect(failureOfA?.message).toContain(
      'while preparing the history files this run could no longer confirm that it holds it',
    );
  });
});
