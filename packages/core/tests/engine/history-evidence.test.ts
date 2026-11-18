import { describe, expect, it } from 'vitest';
import { MemoryStateStore } from '../../src/adapters/memory-state-store';
import type { PreparedConnectionSender } from '../../src/engine/run-engine';
import { runTemplate } from '../../src/engine/run-engine';
import { needsAttention, type RunReport } from '../../src/engine/report';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import type { Recipient } from '../../src/domain/addressing/recipient';
import type { CcPolicy, ResolvedTemplate } from '../../src/domain/catalog/template';
import type { Pacing } from '../../src/domain/catalog/pacing';
import type { ResendPolicy } from '../../src/domain/run/send-selection';
import {
  INTERRUPTED_MESSAGE,
  type RecipientJournalEntry,
  type TemplateState,
} from '../../src/domain/run/template-state';
import { foldJournal } from '../../src/domain/run/fold-journal';
import type { DataSource } from '../../src/ports/data-source';
import type { EmailProvider } from '../../src/ports/email-provider';
import type { Sleeper } from '../../src/ports/sleeper';
import { PER_RECIPIENT, ScriptedSender, TRANSACTION } from '../support/scripted-sender';

const PACING: Pacing = {
  delayBetweenSendsMs: 0,
  maxRetries: 2,
  baseBackoffMs: 1,
  maxBackoffMs: 1,
  maxRetryAfterMs: 5_000,
  maxThrottleWaitMs: 12_000,
};

function address(raw: string): EmailAddress {
  const parsed = parseEmailAddress(raw);

  if (!parsed.ok) {
    throw new Error(`test setup: bad address ${raw}`);
  }

  return parsed.value;
}

function template(ccPolicy: CcPolicy = 'optional'): ResolvedTemplate {
  return {
    id: 't',
    campaignId: 'c',
    ccPolicy,
    connectionIds: ['x'],
    dir: '',
    dataDir: '',
    stateDir: '',
    assetsDir: '',
    compiledHtmlPath: '',
    context: {},
    dataFile: 'list.csv',
    dataPath: '',
    statePath: 'list.json',
    pacing: PACING,
  };
}

class Source implements DataSource {
  constructor(private readonly emails: readonly string[]) {}
  async *read(): AsyncIterable<Readonly<Record<string, string>>> {
    for (const email of this.emails) {
      await Promise.resolve();
      yield { email };
    }
  }
}

class RecordingStore extends MemoryStateStore {
  readonly appended: RecipientJournalEntry[] = [];
  failOutcomes = false;
  failCompaction = false;

  override compact(t: ResolvedTemplate, state: TemplateState): Promise<void> {
    return this.failCompaction ? Promise.reject(new Error('process killed')) : super.compact(t, state);
  }

  override append(t: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    if (this.failOutcomes && 'status' in entry) {
      return Promise.reject(new Error('process killed'));
    }

    this.appended.push(entry);

    return super.append(t, entry);
  }
}

const immediate: Sleeper = { sleep: () => Promise.resolve() };
const accepted = (extra: Record<string, unknown> = {}) => ({ outcome: 'accepted', ...extra });
const unknown = () => ({ outcome: 'unknown', detail: 'connection reset after DATA' });
const transient = () => ({ outcome: 'not-accepted', reason: 'transient', scope: 'message', detail: 'try later' });

interface RunOptions {
  readonly store: RecordingStore;
  readonly emails?: readonly string[];
  readonly sender?: PreparedConnectionSender;
  readonly provider?: EmailProvider;
  readonly policy?: ResendPolicy;
  readonly cc?: readonly string[];
  readonly ccPolicy?: CcPolicy;
  readonly ids?: readonly string[];
  readonly sleeper?: Sleeper;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}

function run(options: RunOptions): Promise<RunReport> {
  const ids = [...(options.ids ?? ['A', 'B', 'C', 'D'])];

  return runTemplate<Recipient>({
    template: template(options.ccPolicy),
    source: new Source(options.emails ?? ['a@x.co']),
    validator: {
      validate: (record) => {
        const email = parseEmailAddress(record['email'] ?? '');

        return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
      },
    },
    renderer: { render: () => ({ subject: 's', html: '<p>x</p>' }) },
    providers: options.provider === undefined ? new Map() : new Map([['x', options.provider]]),
    ...(options.sender === undefined ? {} : { senders: new Map([['x', options.sender]]) }),
    connectionIds: ['x'],
    policy: options.policy ?? { kind: 'pending' },
    mode: { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: options.store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleeper: options.sleeper ?? immediate,
    now: options.now ?? (() => 'NOW'),
    newAttemptId: () => ids.shift() ?? 'exhausted',
    ...(options.cc === undefined ? {} : { cc: options.cc.map(address) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

const recordOf = async (store: RecordingStore, email = 'a@x.co') => (await store.load(template())).recipients[email];

describe('attempt ids in the history', () => {
  it('records one attempt id on the intent and on the outcome, stable across the physical calls', async () => {
    const sender = new ScriptedSender((_message, attempt) => (attempt.call === 1 ? transient() : accepted()));
    const store = new RecordingStore();

    await run({ store, sender: await sender.prepare(PER_RECIPIENT) });

    expect(sender.calls.map((call) => call.attempt)).toEqual([
      { attemptId: 'A', call: 1 },
      { attemptId: 'A', call: 2 },
    ]);
    expect(store.appended).toEqual([
      { email: 'a@x.co', intent: { at: 'NOW', connectionId: 'x', attemptId: 'A' } },
      { email: 'a@x.co', status: { status: 'sent', at: 'NOW', connectionId: 'x', attemptId: 'A' } },
    ]);
  });

  it('records a certain rejection followed by an unknown outcome as uncertain under the same id, with no further call', async () => {
    const sender = new ScriptedSender((_message, attempt) => (attempt.call === 1 ? transient() : unknown()));
    const store = new RecordingStore();
    const summary = await run({ store, sender: await sender.prepare(PER_RECIPIENT) });

    expect(sender.calls).toHaveLength(2);
    expect(summary).toMatchObject({ uncertain: 1, sent: 0 });
    expect(await recordOf(store)).toMatchObject({ status: 'uncertain', attemptId: 'A' });
  });

  it('keeps the attempt id of an intent whose outcome was never recorded, and never sends it again by itself', async () => {
    const sender = new ScriptedSender(() => accepted());
    const store = new RecordingStore();

    store.failOutcomes = true;
    await expect(run({ store, sender: await sender.prepare(PER_RECIPIENT) })).rejects.toThrow(
      /could not record send state/,
    );
    store.failOutcomes = false;

    expect(await recordOf(store)).toEqual({
      status: 'uncertain',
      at: 'NOW',
      connectionId: 'x',
      message: INTERRUPTED_MESSAGE,
      attemptId: 'A',
    });

    const next = await run({ store, sender: await sender.prepare(PER_RECIPIENT), ids: ['B'] });

    expect(sender.calls).toHaveLength(1);
    expect(next).toMatchObject({ heldUncertain: 1, sent: 0 });
  });

  it('records no attempt id for a provider that never receives one', async () => {
    const store = new RecordingStore();

    await run({ store, provider: { send: () => Promise.resolve() } });

    expect(JSON.stringify(store.appended)).not.toContain('attemptId');
    expect(await recordOf(store)).toEqual({ status: 'sent', at: 'NOW', connectionId: 'x' });
  });

  it('releases an intent whose retry wait was cancelled, without recording an outcome', async () => {
    const controller = new AbortController();
    const sender = new ScriptedSender(() => transient());
    const store = new RecordingStore();
    const summary = await run({
      store,
      sender: await sender.prepare(PER_RECIPIENT),
      signal: controller.signal,
      sleeper: {
        sleep: () => {
          controller.abort();

          return Promise.resolve();
        },
      },
    });

    expect(summary).toMatchObject({ notAttempted: 1 });
    expect(store.appended.map((entry) => Object.keys(entry)[1])).toEqual(['intent', 'released']);
    expect(store.appended[1]).toEqual({ email: 'a@x.co', released: { at: 'NOW' } });
    expect(await recordOf(store)).toBeUndefined();
  });
});

describe('provider evidence in the history', () => {
  it('keeps the provider message id only when the provider gives a valid one', async () => {
    const withId = new RecordingStore();
    const without = new RecordingStore();

    await run({
      store: withId,
      sender: await new ScriptedSender(() => accepted({ providerMessageId: 'p-1' })).prepare(TRANSACTION),
    });
    await run({ store: without, sender: await new ScriptedSender(() => accepted()).prepare(TRANSACTION) });

    expect(await recordOf(withId)).toMatchObject({ status: 'sent', providerMessageId: 'p-1' });
    expect(await recordOf(without)).not.toHaveProperty('providerMessageId');
  });

  it('treats an invalid provider message id as a contract violation: uncertain, nothing kept, no retry', async () => {
    const sender = new ScriptedSender(() => accepted({ providerMessageId: '  ' }));
    const store = new RecordingStore();

    expect(await run({ store, sender: await sender.prepare(TRANSACTION) })).toMatchObject({ uncertain: 1 });
    expect(sender.calls).toHaveLength(1);
    expect(await recordOf(store)).toMatchObject({ status: 'uncertain', attemptId: 'A' });
    expect(await recordOf(store)).not.toHaveProperty('providerMessageId');
  });
});

describe('rejected CC in the history', () => {
  const CC = ['records@x.co', 'audit@x.co'];

  it.each([
    ['optional', { rejected: ['records@x.co'], required: false }, false],
    ['required', { rejected: ['records@x.co'], required: true }, true],
  ] as const)(
    'records a %s rejected CC on the sent message, with the policy in force when it was sent',
    async (ccPolicy, cc, attention) => {
      const sender = new ScriptedSender(() => accepted({ ccRejected: ['records@x.co'] }));
      const store = new RecordingStore();
      const summary = await run({ store, sender: await sender.prepare(PER_RECIPIENT), cc: CC, ccPolicy });

      expect(await recordOf(store)).toEqual({ status: 'sent', at: 'NOW', connectionId: 'x', attemptId: 'A', cc });
      expect(summary).toMatchObject({ sent: 1, ccRejectedMessages: 1, requiredCcRejectedMessages: attention ? 1 : 0 });
      expect(needsAttention(summary)).toBe(attention);
    },
  );

  it('counts one message when several of its CC are rejected', async () => {
    const sender = new ScriptedSender(() => accepted({ ccRejected: CC }));
    const summary = await run({
      store: new RecordingStore(),
      sender: await sender.prepare(PER_RECIPIENT),
      cc: CC,
      ccPolicy: 'required',
    });

    expect(summary).toMatchObject({ ccRejectedMessages: 1, requiredCcRejectedMessages: 1 });
  });

  it('records an observed CC with nothing rejected, and counts nothing', async () => {
    const store = new RecordingStore();
    const summary = await run({
      store,
      sender: await new ScriptedSender(() => accepted({ ccRejected: [] })).prepare(PER_RECIPIENT),
      cc: CC,
      ccPolicy: 'required',
    });

    expect(await recordOf(store)).toMatchObject({ cc: { rejected: [], required: true } });
    expect(summary).toMatchObject({ ccRejectedMessages: 0, requiredCcRejectedMessages: 0 });
    expect(needsAttention(summary)).toBe(false);
  });

  it('never queues an accepted message again because a CC was rejected, and a later policy change does not rewrite it', async () => {
    const sender = new ScriptedSender(() => accepted({ ccRejected: ['records@x.co'] }));
    const store = new RecordingStore();

    await run({ store, sender: await sender.prepare(PER_RECIPIENT), cc: CC, ccPolicy: 'required' });
    const later = await run({
      store,
      sender: await sender.prepare(PER_RECIPIENT),
      cc: CC,
      ccPolicy: 'optional',
      ids: ['B'],
    });

    expect(sender.calls).toHaveLength(1);
    expect(later).toMatchObject({ skipped: 1, sent: 0, requiredCcRejectedMessages: 0 });
    expect(await recordOf(store)).toMatchObject({ cc: { rejected: ['records@x.co'], required: true } });
  });

  it.each([
    ['names an address that is not a CC', PER_RECIPIENT, { ccRejected: ['stranger@x.co'] }],
    ['repeats a CC', PER_RECIPIENT, { ccRejected: ['records@x.co', 'records@x.co'] }],
    ['is missing from a per-recipient sender', PER_RECIPIENT, {}],
    ['comes from a sender that only sees whole transactions', TRANSACTION, { ccRejected: [] }],
  ] as const)(
    'records the send as uncertain, with no CC evidence and no retry, when ccRejected %s',
    async (_label, capabilities, extra) => {
      const sender = new ScriptedSender(() => accepted(extra));
      const store = new RecordingStore();
      const summary = await run({ store, sender: await sender.prepare(capabilities), cc: CC });

      expect(summary).toMatchObject({ uncertain: 1, sent: 0, ccRejectedMessages: 0 });
      expect(sender.calls).toHaveLength(1);
      expect(await recordOf(store)).not.toHaveProperty('cc');
    },
  );

  it('records no CC evidence for a sender that only sees whole transactions', async () => {
    const store = new RecordingStore();

    await run({ store, sender: await new ScriptedSender(() => accepted()).prepare(TRANSACTION), cc: CC });

    expect(await recordOf(store)).toEqual({ status: 'sent', at: 'NOW', connectionId: 'x', attemptId: 'A' });
  });
});

describe('uncertain attempts across deliberate resends', () => {
  it('keeps the uncertain resend B after resend C of an already sent message is accepted', async () => {
    const outcomes = [accepted(), unknown(), accepted()];
    const sender = new ScriptedSender(() => outcomes.shift() ?? unknown());
    const store = new RecordingStore();
    const prepared = await sender.prepare(PER_RECIPIENT);

    await run({ store, sender: prepared, ids: ['A'] });
    await run({ store, sender: prepared, ids: ['B'], policy: { kind: 'force-all' } });
    expect(await recordOf(store)).toMatchObject({
      status: 'sent',
      attemptId: 'A',
      resendFailure: { outcome: 'uncertain', attemptId: 'B' },
    });

    await run({ store, sender: prepared, ids: ['C'], policy: { kind: 'force-all' } });
    expect(await recordOf(store)).toEqual({
      status: 'sent',
      at: 'NOW',
      connectionId: 'x',
      attemptId: 'C',
      uncertainAttemptIds: ['B'],
    });
  });

  it('keeps every uncertain attempt, once and in order, when uncertain records replace each other', async () => {
    const outcomes = [unknown(), unknown(), accepted()];
    const sender = new ScriptedSender(() => outcomes.shift() ?? unknown());
    const store = new RecordingStore();
    const prepared = await sender.prepare(PER_RECIPIENT);
    const subset: ResendPolicy = { kind: 'subset', recipients: [address('a@x.co')] };

    await run({ store, sender: prepared, ids: ['A'] });
    await run({ store, sender: prepared, ids: ['B'], policy: subset });
    expect(await recordOf(store)).toMatchObject({ status: 'uncertain', attemptId: 'B', uncertainAttemptIds: ['A'] });

    await run({ store, sender: prepared, ids: ['C'], policy: subset });
    expect(await recordOf(store)).toMatchObject({ status: 'sent', attemptId: 'C', uncertainAttemptIds: ['A', 'B'] });
  });

  it('never retries an uncertain recipient on its own: pending and failed-only hold it', async () => {
    const sender = new ScriptedSender(() => unknown());
    const store = new RecordingStore();
    const prepared = await sender.prepare(PER_RECIPIENT);

    await run({ store, sender: prepared });
    await run({ store, sender: prepared, ids: ['B'] });
    await run({ store, sender: prepared, ids: ['C'], policy: { kind: 'failed-only' } });

    expect(sender.calls).toHaveLength(1);
  });
});

describe('a recipient whose history spans two runs that died', () => {
  it('stays uncertain, and is never sent again on its own, when the later deliberate resend was released before the run died', async () => {
    const sender = new ScriptedSender(() => transient());
    const store = new RecordingStore();
    const prepared = await sender.prepare(PER_RECIPIENT);

    store.failOutcomes = true;
    await expect(
      run({ store, sender: await new ScriptedSender(() => accepted()).prepare(PER_RECIPIENT), ids: ['X'] }),
    ).rejects.toThrow();
    store.failOutcomes = false;

    const controller = new AbortController();

    store.failCompaction = true;
    await expect(
      run({
        store,
        sender: prepared,
        ids: ['Y'],
        policy: { kind: 'subset', recipients: [address('a@x.co')] },
        signal: controller.signal,
        sleeper: {
          sleep: () => {
            controller.abort();

            return Promise.resolve();
          },
        },
      }),
    ).rejects.toThrow(/could not record send state/);
    store.failCompaction = false;

    expect(store.appended.map((entry) => Object.keys(entry)[1])).toEqual(['intent', 'intent', 'released']);
    expect(await recordOf(store)).toMatchObject({ status: 'uncertain', attemptId: 'X', message: INTERRUPTED_MESSAGE });

    const calls = sender.calls.length;

    expect(await run({ store, sender: prepared, ids: ['Z1'] })).toMatchObject({ heldUncertain: 1, sent: 0 });
    expect(await run({ store, sender: prepared, ids: ['Z2'], policy: { kind: 'failed-only' } })).toMatchObject({
      heldUncertain: 1,
    });
    expect(sender.calls).toHaveLength(calls);
  });
});

describe('attempt ids supplied by the caller', () => {
  it.each([
    ['an empty id', ['']],
    ['a blank id', ['  ']],
  ])('refuses %s before writing an intent or sending', async (_label, ids) => {
    const sender = new ScriptedSender(() => accepted());
    const store = new RecordingStore();

    await expect(run({ store, sender: await sender.prepare(PER_RECIPIENT), ids })).rejects.toThrow();
    expect(sender.calls).toEqual([]);
    expect(store.appended).toEqual([]);
  });

  it('refuses an id it already gave to another send in the same run, before that send starts', async () => {
    const sender = new ScriptedSender(() => accepted());
    const store = new RecordingStore();

    await expect(
      run({ store, sender: await sender.prepare(PER_RECIPIENT), emails: ['a@x.co', 'b@x.co'], ids: ['A', 'A'] }),
    ).rejects.toThrow();
    expect(sender.calls.map((call) => call.to)).toEqual(['a@x.co']);
    expect(store.appended.filter((entry) => 'intent' in entry)).toHaveLength(1);
  });
});

describe('the compacted history date (K3)', () => {
  it('dates the snapshot by the last recorded outcome, so replaying a journal left behind changes nothing', async () => {
    let tick = 0;
    const store = new RecordingStore();
    const sender = new ScriptedSender(() => accepted());
    const compacted: TemplateState[] = [];
    const original = store.compact.bind(store);

    store.compact = (t, state) => {
      compacted.push(state);

      return original(t, state);
    };

    await run({
      store,
      sender: await sender.prepare(PER_RECIPIENT),
      emails: ['a@x.co', 'b@x.co'],
      now: () => `T${String((tick += 1)).padStart(2, '0')}`,
    });

    const [snapshot] = compacted;
    const outcomes = store.appended.flatMap((entry) => ('status' in entry ? [entry.status.at] : []));

    expect(snapshot?.updatedAt).toBe(outcomes.at(-1));
    expect(snapshot === undefined ? undefined : foldJournal(snapshot, store.appended)).toEqual(snapshot);
  });

  it('keeps the loaded date when a run records no outcome', async () => {
    const store = new RecordingStore();
    const prepared = await new ScriptedSender(() => accepted()).prepare(PER_RECIPIENT);

    await run({ store, sender: prepared, now: () => 'FIRST' });
    await run({ store, sender: prepared, ids: ['B'], now: () => 'LATER' });

    expect((await store.load(template())).updatedAt).toBe('FIRST');
  });
});

describe('attempt ids repeated across runs (K8)', () => {
  it('refuses an id already recorded for the recipient, before writing the intent or sending', async () => {
    const sender = new ScriptedSender(() => unknown());
    const store = new RecordingStore();
    const prepared = await sender.prepare(PER_RECIPIENT);

    await run({ store, sender: prepared, ids: ['A'] });
    const before = store.appended.length;

    await expect(
      run({ store, sender: prepared, ids: ['A'], policy: { kind: 'subset', recipients: [address('a@x.co')] } }),
    ).rejects.toThrow(/already recorded/);
    expect(sender.calls).toHaveLength(1);
    expect(store.appended).toHaveLength(before);
    expect(await recordOf(store)).toMatchObject({ status: 'uncertain', attemptId: 'A' });
  });
});
