import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upgradeTemplateState } from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { Checkpoints } from '../../support/concurrency/barrier';
import { ChildRun, nextSendOrDone, pumpUntilDone, stopAllChildren } from '../../support/concurrency/child-process';
import { CLI_EMAILS, CLI_STATE } from '../../support/concurrency/cli-run';
import { type ListFixture, listAt, runList, runLocked } from '../../support/concurrency/list-run';
import { preparedLedgerSender, SendLedger } from '../../support/concurrency/send-ledger';

const PACKAGE = resolve(import.meta.dirname, '../../..');
const REFUSED = /can only be written by the store that holds its lock/;
const ONE_EACH = Object.fromEntries(CLI_EMAILS.map((email) => [email, 1]));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-writers-'));
});

afterEach(async () => {
  await stopAllChildren();
  rmSync(dir, { recursive: true, force: true });
});

async function sentRecipients(list: ListFixture): Promise<readonly string[]> {
  const state = upgradeTemplateState(await new FileStateStore().load(list.template));

  return Object.entries(state.recipients)
    .filter(([, status]) => status.status === 'sent')
    .map(([email]) => email)
    .sort();
}

async function pendingAfterwards(list: ListFixture, ledger: SendLedger): Promise<readonly string[]> {
  const sender = await preparedLedgerSender({ ledger, run: 'after', policy: 'pending' });

  await runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', sender]]) });

  return ledger
    .calls()
    .filter((call) => call.run === 'after')
    .map((call) => call.to);
}

const callsOf = (ledger: SendLedger, run: string): number => ledger.calls().filter((call) => call.run === run).length;

describe('C2 — two processes run the SDK on the same list without the lock', { timeout: 60_000 }, () => {
  it('refuses both before either calls the provider, and a locked run then sends each message once', async () => {
    const statePath = join(dir, '.state', 'recipients.json');
    const list = listAt(statePath, CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const job = { kind: 'sdk', statePath, emails: CLI_EMAILS, ledgerPath: ledger.path, lock: false } as const;
    const a = ChildRun.start({ ...job, run: 'A' });
    const firstOfA = await nextSendOrDone(a);
    const b = ChildRun.start({ ...job, run: 'B' });
    const firstOfB = await nextSendOrDone(b);
    const doneA = await pumpUntilDone(a, firstOfA);
    const doneB = await pumpUntilDone(b, firstOfB);

    expect([doneA.ok, doneB.ok]).toEqual([false, false]);
    expect(doneA.detail).toMatch(REFUSED);
    expect(doneB.detail).toMatch(REFUSED);
    expect([callsOf(ledger, 'A'), callsOf(ledger, 'B')]).toEqual([0, 0]);
    expect(await sentRecipients(list)).toEqual([]);
    expect(await pendingAfterwards(list, ledger)).toEqual(CLI_EMAILS);
    expect(ledger.summary().callsPerRecipient).toEqual(ONE_EACH);
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
  });
});

describe('C3 — a CLI run holds the lock while an SDK process tries to write without it', { timeout: 60_000 }, () => {
  it('refuses the SDK before it calls the provider, and the CLI sends each message once', async () => {
    const campaigns = join(dir, 'campaigns');

    cpSync(join(PACKAGE, 'tests/fixtures/campaigns'), campaigns, { recursive: true });

    const statePath = join(campaigns, CLI_STATE);
    const list = listAt(statePath, CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const cli = ChildRun.start({ kind: 'cli', campaigns, cwd: dir, ledgerPath: ledger.path, run: 'CLI' });
    const firstOfCli = await nextSendOrDone(cli);
    const sdk = ChildRun.start({
      kind: 'sdk',
      statePath,
      emails: CLI_EMAILS,
      ledgerPath: ledger.path,
      run: 'SDK',
      lock: false,
    });
    const firstOfSdk = await nextSendOrDone(sdk);
    const doneCli = await pumpUntilDone(cli, firstOfCli);
    const doneSdk = await pumpUntilDone(sdk, firstOfSdk);

    expect(doneCli).toMatchObject({ ok: true });
    expect(doneSdk.ok).toBe(false);
    expect(doneSdk.detail).toMatch(REFUSED);
    expect(callsOf(ledger, 'SDK')).toBe(0);
    expect(await sentRecipients(list)).toEqual([...CLI_EMAILS].sort());
    expect(await pendingAfterwards(list, ledger)).toEqual([]);
    expect(ledger.summary().callsPerRecipient).toEqual(ONE_EACH);
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
  });
});

describe('C5 — two FileStateStore instances in one process, only one holds the lock', () => {
  it('refuses the unlocked instance before it calls the provider, and the locked one sends each message once', async () => {
    const list = listAt(join(dir, '.state', 'recipients.json'), CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const checkpoints = new Checkpoints();
    const gate = (run: string) => (to: string) =>
      checkpoints.isWatched(`${run}:${to}`) ? checkpoints.arrive(`${run}:${to}`) : Promise.resolve();
    const settle = (work: Promise<unknown>): Promise<string> =>
      work.then(
        () => 'ok',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    checkpoints.watch('locked:ada@example.com');
    checkpoints.watch('unlocked:grace@example.com');

    const locked = settle(
      runLocked({
        list,
        store: new FileStateStore(),
        senders: new Map([
          ['outlook-1', await preparedLedgerSender({ ledger, run: 'locked', policy: 'pending', gate: gate('locked') })],
        ]),
      }),
    );

    await checkpoints.reached('locked:ada@example.com');

    const unlocked = settle(
      runList({
        list,
        store: new FileStateStore(),
        senders: new Map([
          [
            'outlook-1',
            await preparedLedgerSender({ ledger, run: 'unlocked', policy: 'pending', gate: gate('unlocked') }),
          ],
        ]),
      }),
    );

    await Promise.race([checkpoints.reached('unlocked:grace@example.com'), unlocked]);
    checkpoints.release('locked:ada@example.com');
    checkpoints.release('unlocked:grace@example.com');

    expect(await locked).toBe('ok');
    expect(await unlocked).toMatch(REFUSED);
    expect(callsOf(ledger, 'unlocked')).toBe(0);
    expect(await sentRecipients(list)).toEqual([...CLI_EMAILS].sort());
    expect(await pendingAfterwards(list, ledger)).toEqual([]);
    expect(ledger.summary().callsPerRecipient).toEqual(ONE_EACH);
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
  });
});
