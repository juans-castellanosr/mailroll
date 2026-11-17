import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  type RecipientJournalEntry,
  type RecipientStatus,
  StatePersistenceError,
  TemplateRunError,
  upgradeTemplateState,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { Checkpoints } from '../../support/concurrency/barrier';
import { CLI_EMAILS } from '../../support/concurrency/cli-run';
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
const GRACE_INTENT_OPEN = 3;
const LOST = 'its lock file no longer belongs to this run';
const LOST_AFTER_INTENT = `ConfigError: the intent to send to ${GRACE} was written to the send state of "welcome" · recipients.csv, but right after it this run could no longer confirm that it holds its lock (${LOST}); nothing was sent to ${GRACE}, and the history now reads it as uncertain`;
const LOST_BEFORE_OUTCOME = `ConfigError: the send state of "welcome" · recipients.csv can only be written by the store that holds its lock and loaded it after taking it (${LOST}); nothing was written`;

type Step = 'W' | 'C' | 'D' | 'L' | 'R';

type Failure =
  | { readonly stage: 'intent'; readonly prefix: string; readonly detail: string }
  | { readonly stage: 'outcome'; readonly prefix: string; readonly detail: string };

interface Ordering {
  readonly steps: readonly Step[];
  readonly graceSentBy: 'A' | 'B' | 'nobody';
  readonly graceHistory: RecipientStatus['status'];
  readonly failureOfA: Failure;
}

const INTENT_REFUSED: Failure = {
  stage: 'intent',
  prefix: `could not record send state before sending to ${GRACE}; `,
  detail: LOST_AFTER_INTENT,
};

const OUTCOME_REFUSED: Failure = {
  stage: 'outcome',
  prefix: `could not record send state after sending to ${GRACE}; `,
  detail: LOST_BEFORE_OUTCOME,
};

const ORDERINGS: readonly Ordering[] = [
  { steps: ['W', 'C', 'D', 'L', 'R'], graceSentBy: 'A', graceHistory: 'uncertain', failureOfA: OUTCOME_REFUSED },
  { steps: ['W', 'D', 'C', 'L', 'R'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['W', 'D', 'L', 'C', 'R'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['W', 'D', 'L', 'R', 'C'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['D', 'W', 'C', 'L', 'R'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['D', 'W', 'L', 'C', 'R'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['D', 'W', 'L', 'R', 'C'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['D', 'L', 'W', 'C', 'R'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['D', 'L', 'W', 'R', 'C'], graceSentBy: 'nobody', graceHistory: 'uncertain', failureOfA: INTENT_REFUSED },
  { steps: ['D', 'L', 'R', 'W', 'C'], graceSentBy: 'B', graceHistory: 'sent', failureOfA: INTENT_REFUSED },
];

let dir: string;
let list: ListFixture;
let ledger: SendLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-after-intent-'));
  list = listAt(join(dir, '.state', 'recipients.json'), CLI_EMAILS);
  ledger = new SendLedger(join(dir, 'calls.jsonl'));
  interleaver.reset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gateOf(checkpoints: Checkpoints, run: string): (to: string) => Promise<void> {
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

const intent = (email: string): RecipientJournalEntry => ({
  email,
  intent: { at: 'T1', connectionId: 'outlook-1', attemptId: `attempt-${email}` },
});

describe('a live run whose lock is deleted and taken by another run around the write of a send intent', () => {
  it.each(ORDERINGS.map((ordering) => [ordering.steps.join(' '), ordering] as const))(
    '%s: no recipient is sent twice, and run A stops with the expected error',
    async (_label, ordering) => {
      const lockPath = `${list.template.statePath}.lock`;
      const checkpoints = new Checkpoints();

      checkpoints.watch(`A:${GRACE}`);
      checkpoints.watch(`B:${GRACE}`);
      checkpoints.watch(`B:${ALAN}`);

      const beforeIntent = interleaver.pauseBefore(
        'A',
        'open',
        GRACE_INTENT_OPEN,
        (file) => file === 'recipients.jsonl',
      );
      const senderA = await preparedLedgerSender({
        ledger,
        run: 'A',
        policy: 'pending',
        gate: gateOf(checkpoints, 'A'),
      });
      const senderB = await preparedLedgerSender({
        ledger,
        run: 'B',
        policy: 'pending',
        gate: gateOf(checkpoints, 'B'),
      });
      const storeB = new FileStateStore();
      const a = settled(
        interleaver.as('A', () =>
          runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderA]]) }),
        ),
      );

      await interleaver.reached(beforeIntent);

      const beforeCheck = interleaver.pauseBefore('A', 'open', 1, (file) => file === 'recipients.json.lock');
      let lockB: Awaited<ReturnType<FileStateStore['lock']>> | undefined;
      let b: Promise<unknown> = Promise.resolve();

      for (const step of ordering.steps) {
        switch (step) {
          case 'W':
            interleaver.release(beforeIntent);
            await Promise.race([interleaver.reached(beforeCheck), checkpoints.reached(`A:${GRACE}`), a]);
            break;
          case 'C':
            interleaver.release(beforeCheck);
            await Promise.race([checkpoints.reached(`A:${GRACE}`), a]);
            break;
          case 'D':
            rmSync(lockPath);
            break;
          case 'L':
            lockB = await storeB.lock(list.template);
            break;
          case 'R':
            b = settled(runList({ list, store: storeB, senders: new Map([['outlook-1', senderB]]) }));
            await Promise.race([checkpoints.reached(`B:${GRACE}`), checkpoints.reached(`B:${ALAN}`), b]);
            break;
        }
      }

      checkpoints.release(`A:${GRACE}`);

      const failureOfA = persistenceErrorOf(await a);

      checkpoints.release(`B:${GRACE}`);
      checkpoints.release(`B:${ALAN}`);

      const failureOfB = await b;

      await lockB?.release();

      const senderAfter = await preparedLedgerSender({ ledger, run: 'after', policy: 'pending' });

      await runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderAfter]]) });

      const summary = ledger.summary();
      const graceCalls = ledger.calls().filter((call) => call.to === GRACE);
      const history = upgradeTemplateState(await new FileStateStore().load(list.template));

      expect(summary.accidentalDuplicates).toEqual([]);
      expect(failureOfB).toBeUndefined();
      expect(graceCalls.map((call) => call.run)).toEqual(
        ordering.graceSentBy === 'nobody' ? [] : [ordering.graceSentBy],
      );
      expect(summary.callsPerRecipient).toEqual({
        [ADA]: 1,
        [ALAN]: 1,
        ...(ordering.graceSentBy === 'nobody' ? {} : { [GRACE]: 1 }),
      });
      expect(ledger.calls().filter((call) => call.run === 'after')).toEqual([]);
      expect(history.recipients[GRACE]?.status).toBe(ordering.graceHistory);
      expect(failureOfA?.recipient).toBe(GRACE);
      expect(failureOfA?.message.startsWith(ordering.failureOfA.prefix)).toBe(true);
      expect(failureOfA?.message).toContain(ordering.failureOfA.detail);
      expect(failureOfA?.cause).toBeInstanceOf(ConfigError);
    },
  );
});

describe('a lock file that cannot be read right after a send intent is written', () => {
  it('rejects the intent as unverifiable, keeps it in the history as uncertain, and refuses every later write', async () => {
    const lockPath = `${list.template.statePath}.lock`;
    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    await store.load(list.template);
    await store.append(list.template, intent(ALAN));

    const ours = readFileSync(lockPath, 'utf8');
    const beforeCheck = interleaver.pauseBefore('A', 'open', 2, (file) => file === 'recipients.json.lock');
    const writing = settled(interleaver.as('A', () => store.append(list.template, intent(GRACE))));

    await Promise.race([interleaver.reached(beforeCheck), writing]);
    rmSync(lockPath);
    mkdirSync(lockPath);
    interleaver.release(beforeCheck);

    const failure = await writing;

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure instanceof Error ? failure.message : '').toContain(
      `was written to the send state of "welcome" · recipients.csv, but right after it this run could no longer confirm that it holds its lock (its lock file could not be read to confirm this run still owns it); nothing was sent to ${GRACE}`,
    );
    expect(failure instanceof Error ? failure.cause : undefined).toBeInstanceOf(Error);
    expect(upgradeTemplateState(await new FileStateStore().load(list.template)).recipients[GRACE]?.status).toBe(
      'uncertain',
    );

    rmSync(lockPath, { recursive: true });
    writeFileSync(lockPath, ours);

    await expect(store.append(list.template, intent(ADA))).rejects.toThrow(LOST);
    await lock.release();
  });
});
