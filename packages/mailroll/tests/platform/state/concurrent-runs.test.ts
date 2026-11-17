import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStateStore,
  type RecipientJournalEntry,
  type ResolvedTemplate,
  type StateLock,
  type StateStore,
  type StoredTemplateState,
  type TemplateState,
  upgradeTemplateState,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { deferred } from '../../support/concurrency/barrier';
import { CLI_EMAILS } from '../../support/concurrency/cli-run';
import { listAt, runList, runLocked } from '../../support/concurrency/list-run';
import { LIST_MESSAGE, preparedLedgerSender, SendLedger } from '../../support/concurrency/send-ledger';

const ONE_EACH = Object.fromEntries(CLI_EMAILS.map((email) => [email, 1]));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-runs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class BothPlanBeforeWriting implements StateStore {
  readonly run = new AsyncLocalStorage<string>();
  loads = 0;
  private readonly bothLoaded = deferred();
  private readonly firstWrote = deferred();

  constructor(private readonly inner: StateStore) {}

  openGates(): void {
    this.bothLoaded.resolve();
    this.firstWrote.resolve();
  }

  async load(template: ResolvedTemplate): Promise<StoredTemplateState> {
    const state = await this.inner.load(template);

    this.loads += 1;

    if (this.loads === 2) {
      this.bothLoaded.resolve();
    }

    return state;
  }

  async append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    const run = this.run.getStore();

    if (run !== undefined) {
      await this.bothLoaded.promise;
    }

    if (run === 'second') {
      await this.firstWrote.promise;
    }

    await this.inner.append(template, entry);

    if (run === 'first') {
      this.firstWrote.resolve();
    }
  }

  compact(template: ResolvedTemplate, state: TemplateState): Promise<void> {
    return this.inner.compact(template, state);
  }

  lock(template: ResolvedTemplate): Promise<StateLock> {
    return this.inner.lock(template);
  }
}

const stores: readonly (readonly [string, () => StateStore])[] = [
  ['FileStateStore', () => new FileStateStore()],
  ['MemoryStateStore', () => new MemoryStateStore()],
];

describe('C6 — two live runTemplate calls on one store instance and one lock', () => {
  it.each(stores)('%s: refuses the second run before it loads, so each message is sent once', async (_name, create) => {
    const list = listAt(join(dir, '.state', 'recipients.json'), CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const store = new BothPlanBeforeWriting(create());
    const run = async (label: string) => {
      const senders = new Map([['outlook-1', await preparedLedgerSender({ ledger, run: label, policy: 'pending' })]]);

      return store.run
        .run(label, () => runList({ list, store, senders }))
        .finally(() => {
          store.openGates();
        });
    };

    const lock = await store.lock(list.template);
    const [first, second] = await Promise.allSettled([run('first'), run('second')]);
    const loadsDuringTheRuns = store.loads;

    await lock.release();

    expect(first).toMatchObject({ status: 'fulfilled', value: { sent: 3 } });
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' && second.reason instanceof Error ? second.reason.message : '').toMatch(
      /is already used by another live run of this state store; nothing was sent/,
    );
    expect(loadsDuringTheRuns).toBe(1);
    expect(ledger.calls().filter((call) => call.run === 'second')).toEqual([]);
    expect(ledger.summary().callsPerRecipient).toEqual(ONE_EACH);

    const afterSender = await preparedLedgerSender({ ledger, run: 'after', policy: 'pending' });

    await runLocked({ list, store, senders: new Map([['outlook-1', afterSender]]) });

    expect(ledger.summary().callsPerRecipient).toEqual(ONE_EACH);
    expect(ledger.summary().accidentalDuplicates).toEqual([]);
    expect(
      Object.values(upgradeTemplateState(await store.load(list.template)).recipients).map((s) => s.status),
    ).toEqual(['sent', 'sent', 'sent']);
  });
});

describe('C7 — two first writes at once on one FileStateStore instance', () => {
  it('records both entries instead of failing one of them', async () => {
    const list = listAt(join(dir, '.state', 'recipients.json'), CLI_EMAILS);
    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    await store.load(list.template);

    const settled = await Promise.allSettled([
      store.append(list.template, { email: 'ada@example.com', intent: { at: 'T1', connectionId: 'outlook-1' } }),
      store.append(list.template, { email: 'grace@example.com', intent: { at: 'T2', connectionId: 'outlook-1' } }),
    ]);

    await lock.release();

    expect(settled.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(Object.keys(upgradeTemplateState(await new FileStateStore().load(list.template)).recipients)).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
  });
});

describe('the duplicate classifier', () => {
  it('counts a deliberate force-all resend as authorized, not as an accidental duplicate', async () => {
    const list = listAt(join(dir, '.state', 'recipients.json'), CLI_EMAILS);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));
    const store = new FileStateStore();

    await runLocked({
      list,
      store,
      senders: new Map([['outlook-1', await preparedLedgerSender({ ledger, run: 'first', policy: 'pending' })]]),
    });
    await runLocked({
      list,
      store,
      policy: { kind: 'force-all' },
      senders: new Map([['outlook-1', await preparedLedgerSender({ ledger, run: 'resend', policy: 'force-all' })]]),
    });

    const summary = ledger.summary();

    expect(summary.callsPerRecipient).toEqual({
      'ada@example.com': 2,
      'grace@example.com': 2,
      'alan@example.org': 2,
    });
    expect(summary.accidentalDuplicates).toEqual([]);
  });

  it('flags a second pending send of an accepted message as an accidental duplicate', async () => {
    const list = listAt(join(dir, '.state', 'recipients.json'), ['ada@example.com']);
    const ledger = new SendLedger(join(dir, 'calls.jsonl'));

    for (const run of ['one', 'two']) {
      await runLocked({
        list,
        store: new MemoryStateStore(),
        senders: new Map([['outlook-1', await preparedLedgerSender({ ledger, run, policy: 'pending' })]]),
      });
    }

    expect(ledger.summary().accidentalDuplicates).toEqual([
      { to: 'ada@example.com', message: LIST_MESSAGE, runs: ['one', 'two'], fingerprints: [expect.any(String)] },
    ]);
  });
});
