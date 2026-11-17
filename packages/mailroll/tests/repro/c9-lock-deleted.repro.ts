import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, parseEmailAddress, type SendOutcome, upgradeTemplateState } from '@mailroll/core';
import { FileStateStore } from '../../src/platform/state/file-state-store';
import { serializeSnapshot } from '../../src/platform/state/history-format';
import { Checkpoints } from '../support/concurrency/barrier';
import { CLI_EMAILS, CLI_STATE, type CliResult, runLiveCli } from '../support/concurrency/cli-run';
import { recordEvidence } from '../support/concurrency/evidence';
import { FailingStore } from '../support/concurrency/failing-store';
import { interleaver } from '../support/concurrency/fs-interleave';
import { listAt, runList, runLocked } from '../support/concurrency/list-run';
import { type CheckedWrite, OwnershipCheckingStore } from '../support/concurrency/ownership-check-prototype';
import { preparedLedgerSender, SendLedger } from '../support/concurrency/send-ledger';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const { interleaver: hooks } = await import('../support/concurrency/fs-interleave');

  return { ...actual, open: hooks.wrap('open', 1, actual.open), rename: hooks.wrap('rename', 2, actual.rename) };
});

const PACKAGE = resolve(import.meta.dirname, '../..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-c9-'));
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

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

interface CliSummary {
  readonly exitCode: number;
  readonly stdout: unknown;
  readonly stderr: string;
}

function summaryOf(result: CliResult): CliSummary {
  const stdout: unknown = result.stdout === '' ? null : JSON.parse(result.stdout);

  return { exitCode: result.exitCode, stdout, stderr: result.stderr.slice(-800) };
}

describe('C9 — the lock file of a live run is deleted while it sends', () => {
  it('never sends a recipient twice when a second CLI run takes the lock', async () => {
    const campaigns = join(dir, 'campaigns');

    cpSync(join(PACKAGE, 'tests/fixtures/campaigns'), campaigns, { recursive: true });

    const statePath = join(campaigns, CLI_STATE);
    const lockPath = `${statePath}.lock`;
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const checkpoints = new Checkpoints();

    checkpoints.watch('A:ada@example.com');
    checkpoints.watch('A:alan@example.org');
    checkpoints.watch('B:grace@example.com');

    const a = runLiveCli({ campaigns, cwd: dir, ledger, run: 'A', gate: gateOf(checkpoints, 'A') });

    await checkpoints.reached('A:ada@example.com');

    const lockOfA = readOptional(lockPath);

    rmSync(lockPath);

    const b = runLiveCli({ campaigns, cwd: dir, ledger, run: 'B', gate: gateOf(checkpoints, 'B') });

    await checkpoints.reached('B:grace@example.com');

    const lockOfB = readOptional(lockPath);

    checkpoints.release('A:ada@example.com');
    await Promise.race([checkpoints.reached('A:alan@example.org'), a]);

    const callsWhileAWaitsOnAlan = ledger.calls().map((call) => `${call.run}:${call.to}`);

    checkpoints.release('B:grace@example.com');

    const resultB = await b;
    const lockAfterB = readOptional(lockPath);

    checkpoints.release('A:alan@example.org');

    const resultA = await a;
    const lockAfterA = readOptional(lockPath);
    const history = upgradeTemplateState(await new FileStateStore().load(listAt(statePath, CLI_EMAILS).template));
    const after = await runLiveCli({ campaigns, cwd: dir, ledger, run: 'after' });
    const summary = ledger.summary();

    recordEvidence('c9-cli-lock-deleted', {
      lockOfA,
      lockOfB,
      callsWhileAWaitsOnAlan,
      lockAfterB,
      lockAfterA,
      a: summaryOf(resultA),
      b: summaryOf(resultB),
      history: history.recipients,
      afterRun: { ...summaryOf(after), calls: ledger.calls().filter((call) => call.run === 'after') },
      calls: ledger.calls(),
      summary,
    });

    expect(summary.accidentalDuplicates, 'recipients sent twice by runs that did not authorize a resend').toEqual([]);
  });

  it('a prototype ownership check before each write lets no duplicate through its check-then-write window, because the store checks again after the intent', async () => {
    const statePath = join(dir, '.state', 'recipients.json');
    const lockPath = `${statePath}.lock`;
    const list = listAt(statePath, CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const checkpoints = new Checkpoints();

    checkpoints.watch('A:checked:grace@example.com');
    checkpoints.watch('B:grace@example.com');

    const prototype = new OwnershipCheckingStore(new FileStateStore(), (write: CheckedWrite) => {
      const name = write !== 'compact' && 'intent' in write ? `A:checked:${write.email}` : '';

      return checkpoints.isWatched(name) ? checkpoints.arrive(name) : Promise.resolve();
    });
    const senderA = await preparedLedgerSender({ ledger, run: 'A', policy: 'pending' });
    const senderB = await preparedLedgerSender({ ledger, run: 'B', policy: 'pending', gate: gateOf(checkpoints, 'B') });
    const a = runLocked({ list, store: prototype, senders: new Map([['outlook-1', senderA]]) }).then(
      (report) => ({ ok: true, report }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );

    await checkpoints.reached('A:checked:grace@example.com');
    rmSync(lockPath);

    const b = runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderB]]) }).then(
      (report) => ({ ok: true, report }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );

    await checkpoints.reached('B:grace@example.com');
    checkpoints.release('A:checked:grace@example.com');

    const outcomeA = await a;

    checkpoints.release('B:grace@example.com');

    const outcomeB = await b;
    const summary = ledger.summary();

    recordEvidence('c9-ownership-check-window', {
      outcomeA,
      outcomeB,
      prototypeRefusals: prototype.refusals,
      calls: ledger.calls(),
      summary,
    });

    expect(summary.accidentalDuplicates, 'the check passed, then the lock was lost before the write').toEqual([]);
  });

  it('sends no message twice when the lock file is deleted between the ownership check and the intent write, because run A checks again after writing its intent and sends nothing', async () => {
    const statePath = join(dir, '.state', 'recipients.json');
    const lockPath = `${statePath}.lock`;
    const list = listAt(statePath, CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const checkpoints = new Checkpoints();
    const aChecked = interleaver.pauseBefore('A', 'open', 3, (file) => file === 'recipients.jsonl');

    checkpoints.watch('B:grace@example.com');

    const senderA = await preparedLedgerSender({ ledger, run: 'A', policy: 'pending' });
    const senderB = await preparedLedgerSender({ ledger, run: 'B', policy: 'pending', gate: gateOf(checkpoints, 'B') });
    const a = interleaver.as('A', () =>
      runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderA]]) }).then(
        (report) => ({ ok: true, sent: report.sent }),
        (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      ),
    );

    await interleaver.reached(aChecked);
    rmSync(lockPath);

    const b = runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderB]]) }).then(
      (report) => ({ ok: true, sent: report.sent }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );

    await checkpoints.reached('B:grace@example.com');
    interleaver.release(aChecked);

    const outcomeA = await a;

    checkpoints.release('B:grace@example.com');

    const outcomeB = await b;
    const summary = ledger.summary();

    recordEvidence('c9-check-then-write-window', { outcomeA, outcomeB, calls: ledger.calls(), summary });

    expect(summary.accidentalDuplicates, 'the former residual window of C9').toEqual([]);
    expect(outcomeA).toMatchObject({ ok: false });
    expect('error' in outcomeA ? outcomeA.error : '').toMatch(
      /StatePersistenceError: could not record send state before sending to grace@example\.com; .*the intent to send to grace@example\.com was written .* but right after it this run could no longer confirm that it holds its lock \(its lock file no longer belongs to this run\); nothing was sent to grace@example\.com/,
    );
    expect(
      ledger
        .calls()
        .filter((call) => call.to === 'grace@example.com')
        .map((call) => call.run),
    ).toEqual(['B']);
  });

  it('control: deleting the lock file after the intent is written lets no duplicate through', async () => {
    const statePath = join(dir, '.state', 'recipients.json');
    const lockPath = `${statePath}.lock`;
    const list = listAt(statePath, CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const checkpoints = new Checkpoints();

    checkpoints.watch('A:grace@example.com');

    const senderA = await preparedLedgerSender({ ledger, run: 'A', policy: 'pending', gate: gateOf(checkpoints, 'A') });
    const senderB = await preparedLedgerSender({ ledger, run: 'B', policy: 'pending' });
    const a = runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderA]]) }).then(
      () => 'ok',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    await checkpoints.reached('A:grace@example.com');
    rmSync(lockPath);
    await runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderB]]) });
    checkpoints.release('A:grace@example.com');

    const outcomeA = await a;
    const summary = ledger.summary();

    recordEvidence('c9-after-intent-control', { outcomeA, calls: ledger.calls(), summary });

    expect(outcomeA).toMatch(/its lock file no longer belongs to this run/);
    expect(summary.accidentalDuplicates).toEqual([]);
  });

  it('residual window: a run suspended between its last ownership check and the rename of its snapshot still overwrites the history of a run that took the list and finished meanwhile', async () => {
    const statePath = join(dir, '.state', 'recipients.json');
    const lockPath = `${statePath}.lock`;
    const listOfA = listAt(statePath, ['ada@example.com', 'grace@example.com']);
    const listOfB = listAt(statePath, CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, serializeSnapshot(emptyState('welcome')), { mode: 0o600 });

    const beforeRename = interleaver.pauseBefore('A', 'rename', 1, (file) =>
      /^recipients\.json\.[0-9a-f-]{36}\.tmp$/.test(file),
    );
    const senderA = await preparedLedgerSender({ ledger, run: 'A', policy: 'pending' });
    const senderB = await preparedLedgerSender({ ledger, run: 'B', policy: 'pending' });
    const senderAfter = await preparedLedgerSender({ ledger, run: 'after', policy: 'pending' });
    const a = interleaver.as('A', () =>
      runLocked({ list: listOfA, store: new FileStateStore(), senders: new Map([['outlook-1', senderA]]) }).then(
        () => 'ok',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    );

    await interleaver.reached(beforeRename);
    rmSync(lockPath);

    const storeB = new FileStateStore();
    const lockB = await storeB.lock(listOfB.template);

    await runList({ list: listOfB, store: storeB, senders: new Map([['outlook-1', senderB]]) });
    await lockB.release();
    interleaver.release(beforeRename);

    const outcomeA = await a;

    await runLocked({ list: listOfB, store: new FileStateStore(), senders: new Map([['outlook-1', senderAfter]]) });

    const summary = ledger.summary();

    recordEvidence('c9-residual-fence-to-rename', { outcomeA, calls: ledger.calls(), summary });

    expect(summary.accidentalDuplicates.map((duplicate) => duplicate.to)).toEqual(['alan@example.org']);
  });

  it('residual window: an outcome a suspended run was already appending lands after the resend of the run that took the list, and a failed-only run then sends that message again', async () => {
    const statePath = join(dir, '.state', 'recipients.json');
    const lockPath = `${statePath}.lock`;
    const grace = parseEmailAddress('grace@example.com');

    if (!grace.ok) {
      throw new Error('test setup: grace@example.com is not a valid address');
    }

    const list = listAt(statePath, ['ada@example.com', 'grace@example.com']);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const rejectGrace = (to: string): SendOutcome =>
      to === 'grace@example.com'
        ? { outcome: 'not-accepted', reason: 'permanent', scope: 'message', detail: 'mailbox refused' }
        : { outcome: 'accepted' };
    const beforeOutcome = interleaver.pauseBefore('A', 'open', 4, (file) => file === 'recipients.jsonl');
    const senderA = await preparedLedgerSender({
      ledger,
      run: 'A',
      policy: 'pending',
      outcome: (message) => rejectGrace(message.to),
    });
    const senderB = await preparedLedgerSender({ ledger, run: 'B', policy: 'subset' });
    const senderAfter = await preparedLedgerSender({ ledger, run: 'after', policy: 'failed-only' });
    const a = interleaver.as('A', () =>
      runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', senderA]]) }).then(
        () => 'ok',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    );

    await interleaver.reached(beforeOutcome);
    rmSync(lockPath);

    const stoppedBeforeCompacting = new FailingStore(new FileStateStore(), { kind: 'compact', written: false });
    const outcomeB = await runLocked({
      list,
      store: stoppedBeforeCompacting,
      policy: { kind: 'subset', recipients: [grace.value] },
      senders: new Map([['outlook-1', senderB]]),
    }).then(
      () => 'ok',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    interleaver.release(beforeOutcome);

    const outcomeA = await a;
    const graceBeforeTheNextRun = upgradeTemplateState(await new FileStateStore().load(list.template)).recipients[
      'grace@example.com'
    ]?.status;

    await runLocked({
      list,
      store: new FileStateStore(),
      policy: { kind: 'failed-only' },
      senders: new Map([['outlook-1', senderAfter]]),
    });

    const summary = ledger.summary();

    recordEvidence('c9-residual-late-outcome', {
      outcomeA,
      outcomeB,
      graceBeforeTheNextRun,
      calls: ledger.calls(),
      summary,
    });

    expect(graceBeforeTheNextRun).toBe('failed');
    expect(summary.accidentalDuplicates.map((duplicate) => duplicate.to)).toEqual(['grace@example.com']);
  });
});
