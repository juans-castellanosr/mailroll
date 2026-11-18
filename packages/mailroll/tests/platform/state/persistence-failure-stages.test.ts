import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  INTERRUPTED_MESSAGE,
  type LogFields,
  type Logger,
  type RecipientJournalEntry,
  type RecipientStatus,
  type ResolvedTemplate,
  type SendOutcome,
  StatePersistenceError,
  type StateStore,
  TemplateRunError,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { Checkpoints, deferred } from '../../support/concurrency/barrier';
import { FailingStore, type WriteFailure } from '../../support/concurrency/failing-store';
import { type ListFixture, listAt, runLocked } from '../../support/concurrency/list-run';
import { preparedLedgerSender, SendLedger } from '../../support/concurrency/send-ledger';

const ADA = 'ada@example.com';
const V1_SNAPSHOT = `${JSON.stringify({ version: 1, templateId: 'welcome', recipients: {}, updatedAt: 'T0' }, null, 2)}\n`;
const GRACE = 'grace@example.com';

let dir: string;
let list: ListFixture;
let ledger: SendLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-stages-'));
  list = listAt(join(dir, '.state', 'recipients.json'), [ADA]);
  ledger = new SendLedger(join(dir, 'calls.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Attempt {
  readonly error: unknown;
  readonly persistence: StatePersistenceError | undefined;
}

async function attempt(
  store: StateStore,
  options: {
    readonly outcome?: SendOutcome;
    readonly policy?: 'pending' | 'force-all';
    readonly signal?: AbortSignal;
  } = {},
): Promise<Attempt> {
  const policy = options.policy ?? 'pending';
  const outcome = options.outcome;
  const sender = await preparedLedgerSender({
    ledger,
    run: 'failing',
    policy,
    ...(outcome === undefined ? {} : { outcome: () => outcome }),
  });
  const error = await runLocked({
    list,
    store,
    policy: { kind: policy },
    senders: new Map([['outlook-1', sender]]),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  const cause = error instanceof TemplateRunError ? error.cause : error;

  return { error, persistence: cause instanceof StatePersistenceError ? cause : undefined };
}

function failing(failure: WriteFailure, inner: StateStore = new FileStateStore()): FailingStore {
  return new FailingStore(inner, failure);
}

function journalPath(): string {
  return `${list.template.statePath.slice(0, -'.json'.length)}.jsonl`;
}

function journalOnDisk(): readonly string[] {
  const path = journalPath();

  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const parsed: unknown = JSON.parse(line);

          if (typeof parsed !== 'object' || parsed === null) {
            return 'other';
          }

          if ('format' in parsed) {
            return 'header';
          }

          if ('intent' in parsed) {
            return 'intent';
          }

          return 'status' in parsed ? 'status' : 'released';
        })
    : [];
}

async function afterRestart(): Promise<Readonly<Record<string, RecipientStatus>>> {
  return (await new FileStateStore().load(list.template)).recipients;
}

async function pendingAfterwards(): Promise<readonly string[]> {
  const sender = await preparedLedgerSender({ ledger, run: 'after', policy: 'pending' });

  await runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', sender]]) });

  return ledger
    .calls()
    .filter((call) => call.run === 'after')
    .map((call) => call.to);
}

const providerCalls = (): number => ledger.calls().filter((call) => call.run === 'failing').length;

const interrupted = { status: 'uncertain', message: INTERRUPTED_MESSAGE };

class ErrorEvents implements Logger {
  readonly errors: { readonly event: string; readonly fields: LogFields }[] = [];

  info(): void {
    return undefined;
  }

  warn(): void {
    return undefined;
  }

  error(event: string, fields: LogFields = {}): void {
    this.errors.push({ event, fields });
  }

  named(event: string): readonly LogFields[] {
    return this.errors.filter((entry) => entry.event === event).map((entry) => entry.fields);
  }
}

class AbortAfterIntent implements StateStore {
  constructor(
    private readonly inner: StateStore,
    private readonly controller: AbortController,
  ) {}

  load(template: ResolvedTemplate): ReturnType<StateStore['load']> {
    return this.inner.load(template);
  }

  lock(template: ResolvedTemplate): ReturnType<StateStore['lock']> {
    return this.inner.lock(template);
  }

  compact(template: ResolvedTemplate, state: Parameters<StateStore['compact']>[1]): Promise<void> {
    return this.inner.compact(template, state);
  }

  async append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    await this.inner.append(template, entry);

    if ('intent' in entry) {
      this.controller.abort();
    }
  }
}

type TamperedWrite = 'intent' | 'status' | 'compact';

class TamperedBefore implements StateStore {
  constructor(
    private readonly inner: StateStore,
    private readonly write: TamperedWrite,
    private readonly tamper: () => void,
  ) {}

  load(template: ResolvedTemplate): ReturnType<StateStore['load']> {
    return this.inner.load(template);
  }

  lock(template: ResolvedTemplate): ReturnType<StateStore['lock']> {
    return this.inner.lock(template);
  }

  compact(template: ResolvedTemplate, state: Parameters<StateStore['compact']>[1]): Promise<void> {
    if (this.write === 'compact') {
      this.tamper();
    }

    return this.inner.compact(template, state);
  }

  append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    if (this.write !== 'compact' && this.write in entry) {
      this.tamper();
    }

    return this.inner.append(template, entry);
  }
}

const deleteLock = (): void => {
  rmSync(`${list.template.statePath}.lock`);
};

const deleteJournal = (): void => {
  rmSync(journalPath());
};

const LOST_LOCK =
  'ConfigError: the send state of "welcome" · recipients.csv can only be written by the store that holds its lock and loaded it after taking it (its lock file no longer belongs to this run); nothing was written';

describe('a history write that fails at each stage of a live send', () => {
  it('intent not written: the provider is not called, nothing is recorded, and the next pending run sends once', async () => {
    const { persistence } = await attempt(failing({ kind: 'intent', written: false }));

    expect(providerCalls()).toBe(0);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toContain('did not call the provider');
    expect(persistence?.message).not.toContain('check whether it was delivered');
    expect(journalOnDisk()).toEqual([]);
    expect(await afterRestart()).toEqual({});
    expect(await pendingAfterwards()).toEqual([ADA]);
  });

  it('intent written but its flush fails: the provider is not called, yet the restart reads the send as uncertain', async () => {
    const { persistence } = await attempt(failing({ kind: 'intent', written: true }));

    expect(providerCalls()).toBe(0);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toContain('did not call the provider');
    expect(persistence?.message).not.toContain('check whether it was delivered');
    expect(journalOnDisk()).toEqual(['header', 'intent']);
    expect((await afterRestart())[ADA]).toMatchObject(interrupted);
    expect(await pendingAfterwards()).toEqual([]);
  });

  it.each<readonly [string, SendOutcome]>([
    ['accepted', { outcome: 'accepted' }],
    ['unknown', { outcome: 'unknown', detail: 'connection reset after DATA' }],
    [
      'a certain rejection',
      { outcome: 'not-accepted', reason: 'permanent', scope: 'message', detail: 'no such mailbox' },
    ],
  ])(
    'outcome after %s not written: one provider call, and the restart reads the send as uncertain, never resent',
    async (_label, outcome) => {
      const { persistence } = await attempt(failing({ kind: 'status', written: false }), { outcome });

      expect(providerCalls()).toBe(1);
      expect(persistence?.recipient).toBe(ADA);
      expect(persistence?.message).toContain('check whether it was delivered');
      expect(persistence?.message).not.toContain('did not call the provider');
      expect(journalOnDisk()).toEqual(['header', 'intent']);
      expect((await afterRestart())[ADA]).toMatchObject(interrupted);
      expect(await pendingAfterwards()).toEqual([]);
    },
  );

  it('release after an authentication rejection not written: one provider call, and the restart reads the send as uncertain', async () => {
    const { persistence } = await attempt(failing({ kind: 'released', written: false }), {
      outcome: { outcome: 'not-accepted', reason: 'auth', scope: 'connection', detail: 'token expired' },
    });

    expect(providerCalls()).toBe(1);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toContain('may not have been called');
    expect(persistence?.message).not.toContain('did not call the provider');
    expect(journalOnDisk()).toEqual(['header', 'intent']);
    expect((await afterRestart())[ADA]).toMatchObject(interrupted);
    expect(await pendingAfterwards()).toEqual([]);
  });

  it('release after a stop before any provider call not written: no call, and the restart still reads the send as uncertain', async () => {
    const controller = new AbortController();
    const { persistence } = await attempt(
      failing({ kind: 'released', written: false }, new AbortAfterIntent(new FileStateStore(), controller)),
      { signal: controller.signal },
    );

    expect(providerCalls()).toBe(0);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toContain('may not have been called');
    expect(persistence?.message).not.toContain('did not call the provider');
    expect(journalOnDisk()).toEqual(['header', 'intent']);
    expect((await afterRestart())[ADA]).toMatchObject(interrupted);
    expect(await pendingAfterwards()).toEqual([]);
  });

  it('compaction not written: every outcome stays in the journal, the error names no recipient, and nothing is resent', async () => {
    const { error } = await attempt(failing({ kind: 'compact', written: false }));

    expect(providerCalls()).toBe(1);
    expect(error).toBeInstanceOf(StatePersistenceError);
    expect(error instanceof StatePersistenceError ? error.recipient : 'not a persistence error').toBeUndefined();
    expect(error instanceof StatePersistenceError ? error.message : '').toContain('no recorded outcome is lost');
    expect(journalOnDisk()).toEqual(['header', 'intent', 'status']);
    expect((await afterRestart())[ADA]).toMatchObject({ status: 'sent' });
    expect(await pendingAfterwards()).toEqual([]);
  });

  it('lock lost before the intent: the store refusal reaches the caller as a StatePersistenceError, not a ConfigError', async () => {
    const { error, persistence } = await attempt(new TamperedBefore(new FileStateStore(), 'intent', deleteLock));

    expect(error).toBeInstanceOf(TemplateRunError);
    expect(providerCalls()).toBe(0);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toMatch(/^could not record send state before sending to ada@example\.com; /);
    expect(persistence?.message).toContain(LOST_LOCK);
    expect(persistence?.cause).toBeInstanceOf(ConfigError);
    expect(journalOnDisk()).toEqual([]);
  });

  it('lock lost before the snapshot: the run throws a StatePersistenceError with the store refusal as its cause', async () => {
    const { error } = await attempt(new TamperedBefore(new FileStateStore(), 'compact', deleteLock));

    expect(providerCalls()).toBe(1);
    expect(error).toBeInstanceOf(StatePersistenceError);
    expect(error instanceof StatePersistenceError ? error.recipient : 'not a persistence error').toBeUndefined();
    expect(error instanceof StatePersistenceError ? error.message : '').toMatch(
      /^could not record send state snapshot; /,
    );
    expect(error instanceof StatePersistenceError ? error.message : '').toContain(LOST_LOCK);
    expect(error instanceof StatePersistenceError ? error.cause : undefined).toBeInstanceOf(ConfigError);
    expect(journalOnDisk()).toEqual(['header', 'intent', 'status']);
  });

  it('journal deleted before the outcome: the store refusal reaches the caller as a StatePersistenceError, and the send is no longer in the history', async () => {
    const { error, persistence } = await attempt(new TamperedBefore(new FileStateStore(), 'status', deleteJournal));

    expect(error).toBeInstanceOf(TemplateRunError);
    expect(providerCalls()).toBe(1);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toMatch(/^could not record send state after sending to ada@example\.com; /);
    expect(persistence?.message).toContain(
      `ConfigError: the state journal at ${journalPath()} disappeared during the run; nothing was written, and the run stops so no send goes unrecorded`,
    );
    expect(persistence?.cause).toBeInstanceOf(ConfigError);
    expect(journalOnDisk()).toEqual([]);
    expect(await afterRestart()).toEqual({});
  });

  it('history in an unsupported format at load: the run is refused with a ConfigError before any write, and nothing changes', async () => {
    mkdirSync(dirname(list.template.statePath), { recursive: true });
    writeFileSync(list.template.statePath, V1_SNAPSHOT);

    const { error, persistence } = await attempt(new FileStateStore());

    expect(providerCalls()).toBe(0);
    expect(persistence).toBeUndefined();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error instanceof Error ? error.message : '').toContain(`invalid state file at ${list.template.statePath}: `);
    expect(error instanceof Error ? error.message : '').toMatch(/version/);
    expect(readFileSync(list.template.statePath, 'utf8')).toBe(V1_SNAPSHOT);
    expect(journalOnDisk()).toEqual([]);
  });

  it('history in an unsupported format that appears after the load: the refusal at the first write reaches the caller as a StatePersistenceError, and nothing changes', async () => {
    const plant = (): void => {
      mkdirSync(dirname(list.template.statePath), { recursive: true });
      writeFileSync(list.template.statePath, V1_SNAPSHOT);
    };

    const { error, persistence } = await attempt(new TamperedBefore(new FileStateStore(), 'intent', plant));

    expect(error).toBeInstanceOf(TemplateRunError);
    expect(providerCalls()).toBe(0);
    expect(persistence?.recipient).toBe(ADA);
    expect(persistence?.message).toMatch(/^could not record send state before sending to ada@example\.com; /);
    expect(persistence?.message).toContain(`ConfigError: invalid state file at ${list.template.statePath}: `);
    expect(persistence?.cause).toBeInstanceOf(ConfigError);
    expect(readFileSync(list.template.statePath, 'utf8')).toBe(V1_SNAPSHOT);
    expect(journalOnDisk()).toEqual([]);
  });

  it('outcome of a deliberate resend of a sent recipient not written: the restart keeps sent and records the uncertain resend', async () => {
    const first = await preparedLedgerSender({ ledger, run: 'first', policy: 'pending' });

    await runLocked({ list, store: new FileStateStore(), senders: new Map([['outlook-1', first]]) });

    const { persistence } = await attempt(failing({ kind: 'status', written: false }), { policy: 'force-all' });
    const record = (await afterRestart())[ADA];

    expect(providerCalls()).toBe(1);
    expect(persistence?.recipient).toBe(ADA);
    expect(record).toMatchObject({
      status: 'sent',
      resendFailure: { outcome: 'uncertain', message: INTERRUPTED_MESSAGE },
    });
    expect(await pendingAfterwards()).toEqual([]);
  });

  it('one failed write stops the other connection from recording an accepted outcome; the error names the first recipient and both are logged as unrecorded', async () => {
    list = listAt(list.template.statePath, [ADA, GRACE]);

    const checkpoints = new Checkpoints();
    const adaFailed = deferred();
    const gate = (to: string): Promise<void> => checkpoints.arrive(to);
    const store = failing({
      kind: 'status',
      email: ADA,
      written: false,
      beforeFailing: () => {
        adaFailed.resolve();
      },
    });
    const senders = new Map([
      ['outlook-1', await preparedLedgerSender({ ledger, run: 'failing', policy: 'pending', gate })],
      ['outlook-2', await preparedLedgerSender({ ledger, run: 'failing', policy: 'pending', gate })],
    ]);
    const events = new ErrorEvents();
    const run = runLocked({ list, store, senders, logger: events }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    await Promise.all([checkpoints.reached(ADA), checkpoints.reached(GRACE)]);
    checkpoints.release(ADA);
    await adaFailed.promise;
    checkpoints.release(GRACE);

    const error = await run;
    const cause = error instanceof TemplateRunError ? error.cause : error;
    const summary = error instanceof TemplateRunError ? error.report : undefined;
    const restarted = await afterRestart();
    const outcomeWrites = store.attempted.flatMap((entry) =>
      entry !== 'compact' && 'status' in entry ? [entry.email] : [],
    );

    expect(providerCalls()).toBe(2);
    expect(cause instanceof StatePersistenceError ? cause.recipient : undefined).toBe(ADA);
    expect(summary?.sent).toBe(2);
    expect(outcomeWrites).toEqual([ADA]);
    expect(events.named('state.flush_failed')).toEqual([]);
    expect(events.named('recipient.unrecorded').map(({ email, stage }) => [email, stage])).toEqual([
      [ADA, 'outcome'],
      [GRACE, 'outcome'],
    ]);
    expect(events.named('recipient.unrecorded').every(({ attemptId }) => typeof attemptId === 'string')).toBe(true);
    expect(restarted[ADA]).toMatchObject(interrupted);
    expect(restarted[GRACE]).toMatchObject(interrupted);
    expect(await pendingAfterwards()).toEqual([]);
  });
});
