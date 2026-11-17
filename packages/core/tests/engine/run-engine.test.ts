import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import {
  SendCancelledError,
  SendError,
  StatePersistenceError,
  TemplateRenderError,
} from '../../src/domain/kernel/errors';
import type { Message } from '../../src/domain/messaging/message';
import type { Recipient } from '../../src/domain/addressing/recipient';
import type { RenderedEmail } from '../../src/domain/messaging/rendered-email';
import type { RunMode } from '../../src/domain/run/run-mode';
import type { ResendPolicy } from '../../src/domain/run/send-selection';
import type { SourceRecord } from '../../src/domain/addressing/source-record';
import type { ResolvedTemplate } from '../../src/domain/catalog/template';
import {
  type RecipientJournalEntry,
  type StoredTemplateState,
  type TemplateState,
  type TemplateStateV1,
  emptyState,
} from '../../src/domain/run/template-state';
import type { ValidationOutcome } from '../../src/domain/kernel/validation-outcome';
import { runTemplate } from '../../src/engine/run-engine';
import { TemplateRunError } from '../../src/engine/template-run-error';
import type { DataSource } from '../../src/ports/data-source';
import type { EmailProvider } from '../../src/ports/email-provider';
import type { LogFields, Logger } from '../../src/ports/logger';
import type { RecipientValidator } from '../../src/ports/recipient-validator';
import type { Sleeper } from '../../src/ports/sleeper';
import type { StateLock, StateStore } from '../../src/ports/state-store';
import type { TemplateRenderer } from '../../src/ports/template-renderer';

interface TestRecipient extends Recipient {
  readonly username: string;
  readonly password: string;
}

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

class FakeDataSource implements DataSource {
  constructor(private readonly records: readonly SourceRecord[]) {}

  async *read(): AsyncIterable<SourceRecord> {
    for (const record of this.records) {
      await Promise.resolve();
      yield record;
    }
  }
}

class FakeValidator implements RecipientValidator<TestRecipient> {
  validate(record: SourceRecord): ValidationOutcome<TestRecipient> {
    const email = parseEmailAddress(record['email'] ?? '');
    const username = record['username'] ?? '';
    const password = record['password'] ?? '';

    if (!email.ok || username.length === 0 || password.length === 0) {
      return { ok: false, reasons: ['invalid row'] };
    }

    return { ok: true, value: { email: email.value, username, password } };
  }
}

class CountingRenderer implements TemplateRenderer<TestRecipient> {
  render(recipient: TestRecipient): RenderedEmail {
    return { subject: `S ${recipient.username}`, html: `<p>${recipient.username}:${recipient.password}</p>` };
  }
}

class RecordingProvider implements EmailProvider {
  readonly messages: Message[] = [];

  async send(message: Message): Promise<void> {
    await Promise.resolve();
    this.messages.push(message);
  }
}

class AuthFailProvider implements EmailProvider {
  async send(): Promise<void> {
    await Promise.resolve();
    throw new SendError('401', 'auth');
  }
}

class FakeStateStore implements StateStore {
  saved: TemplateState | undefined;
  readonly appended: RecipientJournalEntry[] = [];
  failAppendAt: number | undefined;
  failCompact = false;
  constructor(private readonly initial: StoredTemplateState) {}

  lock(): Promise<StateLock> {
    return Promise.resolve({ release: () => Promise.resolve() });
  }

  async load(): Promise<StoredTemplateState> {
    await Promise.resolve();

    return this.saved ?? this.initial;
  }

  async append(_template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    await Promise.resolve();

    if (this.failAppendAt === this.appended.length + 1) {
      throw new Error('ENOSPC: no space left on device');
    }

    this.appended.push(entry);
  }

  async compact(_template: ResolvedTemplate, state: TemplateState): Promise<void> {
    await Promise.resolve();

    if (this.failCompact) {
      throw new Error('ENOSPC: no space left on device');
    }

    this.saved = state;
  }
}

interface LogEntry {
  readonly level: string;
  readonly event: string;
  readonly fields?: LogFields;
}

class SpyLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(event: string, fields?: LogFields): void {
    this.entries.push(fields ? { level: 'info', event, fields } : { level: 'info', event });
  }

  warn(event: string, fields?: LogFields): void {
    this.entries.push(fields ? { level: 'warn', event, fields } : { level: 'warn', event });
  }

  error(event: string, fields?: LogFields): void {
    this.entries.push(fields ? { level: 'error', event, fields } : { level: 'error', event });
  }

  events(): string[] {
    return this.entries.map((e) => e.event);
  }
}

class ImmediateSleeper implements Sleeper {
  async sleep(): Promise<void> {
    await Promise.resolve();
  }
}

const TEMPLATE: ResolvedTemplate = {
  id: 't',
  campaignId: 'c',
  ccPolicy: 'forbidden',
  connectionIds: ['a', 'b'],
  dir: '',
  dataDir: '',
  stateDir: '',
  assetsDir: '',
  compiledHtmlPath: '',
  context: {},
  dataFile: 'recipients.csv',
  dataPath: '',
  statePath: '',
};

const rec = (email: string, username = 'u', password = 'pw'): SourceRecord => ({ email, username, password });

async function runWith(opts: {
  readonly records: readonly SourceRecord[];
  readonly providers: ReadonlyMap<string, EmailProvider>;
  readonly connectionIds: readonly string[];
  readonly mode?: RunMode;
  readonly policy?: ResendPolicy;
  readonly initial?: StoredTemplateState;
  readonly store?: FakeStateStore;
  readonly renderer?: TemplateRenderer<TestRecipient>;
  readonly signal?: AbortSignal;
  readonly logger?: SpyLogger;
}) {
  const logger = opts.logger ?? new SpyLogger();
  const store = opts.store ?? new FakeStateStore(opts.initial ?? emptyState('t'));
  const report = await runTemplate<TestRecipient>({
    template: TEMPLATE,
    source: new FakeDataSource(opts.records),
    validator: new FakeValidator(),
    renderer: opts.renderer ?? new CountingRenderer(),
    providers: opts.providers,
    connectionIds: opts.connectionIds,
    policy: opts.policy ?? { kind: 'pending' },
    mode: opts.mode ?? { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: store,
    logger,
    sleeper: new ImmediateSleeper(),
    now: () => 'NOW',
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  return { report, logger, store };
}

describe('runTemplate', () => {
  it('round-robins valid recipients across connections', async () => {
    const pa = new RecordingProvider();
    const pb = new RecordingProvider();
    const { report } = await runWith({
      records: [rec('r0@x.co'), rec('r1@x.co'), rec('r2@x.co'), rec('r3@x.co')],
      providers: new Map([
        ['a', pa],
        ['b', pb],
      ]),
      connectionIds: ['a', 'b'],
    });

    expect(report.sent).toBe(4);
    expect(pa.messages.map((m) => m.to)).toEqual(['r0@x.co', 'r2@x.co']);
    expect(pb.messages.map((m) => m.to)).toEqual(['r1@x.co', 'r3@x.co']);
  });

  it('skips invalid rows without sending them', async () => {
    const p = new RecordingProvider();
    const { report } = await runWith({
      records: [rec('ok@x.co'), rec('bad-email'), rec('nopw@x.co', 'u', '')],
      providers: new Map([['x', p]]),
      connectionIds: ['x'],
    });

    expect(report).toMatchObject({ sent: 1, skipped: 2 });
    expect(p.messages).toHaveLength(1);
  });

  it('pending policy skips recipients already sent per state', async () => {
    const p = new RecordingProvider();
    const initial: TemplateStateV1 = {
      version: 1,
      templateId: 't',
      recipients: { 'a@x.co': { status: 'sent', at: 'old', connectionId: 'x' } },
      updatedAt: 'old',
    };
    const { report } = await runWith({
      records: [rec('a@x.co'), rec('b@x.co')],
      providers: new Map([['x', p]]),
      connectionIds: ['x'],
      initial,
    });

    expect(report).toMatchObject({ sent: 1, skipped: 1 });
    expect(p.messages.map((m) => m.to)).toEqual(['b@x.co']);
  });

  it('persists state on a live run but not on dry-run', async () => {
    const live = await runWith({
      records: [rec('a@x.co')],
      providers: new Map([['x', new RecordingProvider()]]),
      connectionIds: ['x'],
      mode: { kind: 'live' },
    });

    expect(live.store.saved?.recipients['a@x.co']).toMatchObject({ status: 'sent' });

    const dry = await runWith({
      records: [rec('a@x.co')],
      providers: new Map([['x', new RecordingProvider()]]),
      connectionIds: ['x'],
      mode: { kind: 'dry-run' },
    });

    expect(dry.store.saved).toBeUndefined();
  });

  it('journals every send on a live run (durable against interruption)', async () => {
    const live = await runWith({
      records: [rec('a@x.co'), rec('b@x.co'), rec('c@x.co')],
      providers: new Map([['x', new RecordingProvider()]]),
      connectionIds: ['x'],
      mode: { kind: 'live' },
    });

    expect(
      live.store.appended.map((e) => [
        e.email,
        'intent' in e ? 'intent' : 'status' in e ? e.status.status : 'released',
      ]),
    ).toEqual([
      ['a@x.co', 'intent'],
      ['a@x.co', 'sent'],
      ['b@x.co', 'intent'],
      ['b@x.co', 'sent'],
      ['c@x.co', 'intent'],
      ['c@x.co', 'sent'],
    ]);
  });

  it('quarantines a connection on auth failure while others finish', async () => {
    const pb = new RecordingProvider();
    const { report, logger } = await runWith({
      records: [rec('r0@x.co'), rec('r1@x.co'), rec('r2@x.co'), rec('r3@x.co')],
      providers: new Map<string, EmailProvider>([
        ['a', new AuthFailProvider()],
        ['b', pb],
      ]),
      connectionIds: ['a', 'b'],
    });

    expect(report).toMatchObject({ sent: 2, failed: 0, notAttempted: 2, skipped: 0, total: 4 });
    expect(report.results.filter((r) => r.status === 'not-attempted').map((r) => r.recipient)).toEqual([
      'r0@x.co',
      'r2@x.co',
    ]);
    expect(pb.messages).toHaveLength(2);
    expect(logger.events()).toContain('connection.quarantined');
  });

  it('reports a duplicate email as skipped and sends the first occurrence only', async () => {
    const p = new RecordingProvider();
    const { report } = await runWith({
      records: [rec('dup@x.co', 'first'), rec('dup@x.co', 'second'), rec('other@x.co')],
      providers: new Map([['x', p]]),
      connectionIds: ['x'],
    });

    expect(report).toMatchObject({ sent: 2, skipped: 1 });
    expect(p.messages.map((m) => m.to)).toEqual(['dup@x.co', 'other@x.co']);
  });

  it('overrides the destination in test mode and does not persist', async () => {
    const p = new RecordingProvider();
    const { store } = await runWith({
      records: [rec('a@x.co'), rec('b@x.co')],
      providers: new Map([['x', p]]),
      connectionIds: ['x'],
      mode: { kind: 'test', testRecipient: addr('qa@example.org') },
    });

    expect(p.messages.map((m) => m.to)).toEqual(['qa@example.org', 'qa@example.org']);
    expect(store.saved).toBeUndefined();
  });

  it('never passes a password to the logger', async () => {
    const secret = 'PW-must-not-log-42';
    const logger = new SpyLogger();
    const store = new FakeStateStore(emptyState('t'));

    await runTemplate<TestRecipient>({
      template: TEMPLATE,
      source: new FakeDataSource([{ email: 'a@x.co', username: 'u', password: secret }]),
      validator: new FakeValidator(),
      renderer: new CountingRenderer(),
      providers: new Map([['x', new RecordingProvider()]]),
      connectionIds: ['x'],
      policy: { kind: 'force-all' },
      mode: { kind: 'live' },
      delayBetweenSendsMs: 0,
      stateStore: store,
      logger,
      sleeper: new ImmediateSleeper(),
      now: () => 'NOW',
    });

    const serialized = JSON.stringify(logger.entries);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('<p>');
  });

  it('records an ambiguous send as uncertain, and a pending run does not resend it', async () => {
    class UncertainProvider implements EmailProvider {
      async send(): Promise<void> {
        await Promise.resolve();
        throw new SendError('timed out after the request was sent', 'uncertain');
      }
    }

    const first = await runWith({
      records: [rec('a@x.co')],
      providers: new Map([['x', new UncertainProvider()]]),
      connectionIds: ['x'],
    });

    expect(first.report).toMatchObject({ uncertain: 1, failed: 0 });

    const saved = first.store.saved;

    expect(saved?.recipients['a@x.co']).toMatchObject({ status: 'uncertain' });

    const p = new RecordingProvider();
    const second = await runWith({
      records: [rec('a@x.co')],
      providers: new Map([['x', p]]),
      connectionIds: ['x'],
      ...(saved ? { initial: saved } : {}),
    });

    expect(p.messages).toEqual([]);
    expect(second.report).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('never downgrades a sent recipient when a deliberate resend fails', async () => {
    class FailProvider implements EmailProvider {
      async send(): Promise<void> {
        await Promise.resolve();
        throw new SendError('mailbox full', 'permanent');
      }
    }

    const initial: TemplateStateV1 = {
      version: 1,
      templateId: 't',
      recipients: { 'a@x.co': { status: 'sent', at: 'T0', connectionId: 'x' } },
      updatedAt: 'T0',
    };
    const { store, report } = await runWith({
      records: [rec('a@x.co')],
      providers: new Map([['x', new FailProvider()]]),
      connectionIds: ['x'],
      policy: { kind: 'force-all' },
      initial,
    });

    expect(report.failed).toBe(1);
    expect(store.saved?.recipients['a@x.co']).toEqual({
      status: 'sent',
      at: 'T0',
      connectionId: 'x',
      resendFailure: {
        at: 'NOW',
        connectionId: 'x',
        outcome: 'failed',
        message: 'mailbox full',
        category: 'permanent',
      },
    });
  });

  it('stops every queue on a render defect and still saves what was sent', async () => {
    class BrokenOnRenderer implements TemplateRenderer<TestRecipient> {
      render(recipient: TestRecipient): RenderedEmail {
        if (recipient.username === 'boom') {
          throw new TemplateRenderError('marker missing');
        }

        return { subject: 's', html: '<p>ok</p>' };
      }
    }

    const pa = new RecordingProvider();
    const pb = new RecordingProvider();
    const store = new FakeStateStore(emptyState('t'));

    await expect(
      runWith({
        records: [
          rec('a0@x.co'),
          rec('b0@x.co'),
          rec('a1@x.co', 'boom'),
          rec('b1@x.co'),
          rec('a2@x.co'),
          rec('b2@x.co'),
          rec('a3@x.co'),
          rec('b3@x.co'),
        ],
        providers: new Map([
          ['a', pa],
          ['b', pb],
        ]),
        connectionIds: ['a', 'b'],
        store,
        renderer: new BrokenOnRenderer(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TemplateRunError &&
        error.cause instanceof TemplateRenderError &&
        error.report.sent === pa.messages.length + pb.messages.length,
    );
    expect(pb.messages.length).toBeLessThanOrEqual(2);
    expect(store.saved).toBeDefined();
    expect(Object.keys(store.saved?.recipients ?? {}).sort()).toEqual(
      [...pa.messages, ...pb.messages].map((m) => m.to).sort(),
    );
  });

  it('a failure to record a delivered message stops the run and is never reported as a failed send', async () => {
    const p = new RecordingProvider();
    const store = new FakeStateStore(emptyState('t'));

    store.failAppendAt = 2;
    const logger = new SpyLogger();
    const run = runTemplate<TestRecipient>({
      template: TEMPLATE,
      source: new FakeDataSource([rec('a@x.co'), rec('b@x.co')]),
      validator: new FakeValidator(),
      renderer: new CountingRenderer(),
      providers: new Map([['x', p]]),
      connectionIds: ['x'],
      policy: { kind: 'pending' },
      mode: { kind: 'live' },
      delayBetweenSendsMs: 0,
      stateStore: store,
      logger,
      sleeper: new ImmediateSleeper(),
      now: () => 'NOW',
    });
    const error: unknown = await run.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemplateRunError);
    const cause = (error as TemplateRunError).cause;

    expect(cause).toBeInstanceOf(StatePersistenceError);
    expect(cause).toMatchObject({ recipient: 'a@x.co' });
    expect(p.messages.map((m) => m.to)).toEqual(['a@x.co']);
    expect(logger.events()).not.toContain('recipient.failed');
  });

  it('stops a connection after 3 uncertain outcomes in a row; the rest stay safely pending', async () => {
    let calls = 0;

    class OutageProvider implements EmailProvider {
      async send(): Promise<void> {
        calls += 1;
        await Promise.resolve();
        throw new SendError('HTTP 504', 'uncertain');
      }
    }

    const { report } = await runWith({
      records: [rec('a@x.co'), rec('b@x.co'), rec('c@x.co'), rec('d@x.co'), rec('e@x.co')],
      providers: new Map([['x', new OutageProvider()]]),
      connectionIds: ['x'],
    });

    expect(calls).toBe(3);
    expect(report).toMatchObject({ uncertain: 3, notAttempted: 2 });
  });

  it('a fatal error elsewhere ends waits early: nothing new is sent after it', async () => {
    class WaitingProvider implements EmailProvider {
      readonly sent: string[] = [];
      async send(message: Message, options?: { signal?: AbortSignal }): Promise<void> {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();

            return;
          }

          options?.signal?.addEventListener('abort', () => {
            resolve();
          });
        });
        if (options?.signal?.aborted === true) {
          throw new SendCancelledError('stopped while waiting');
        }

        this.sent.push(message.to);
      }
    }
    class Broken implements TemplateRenderer<TestRecipient> {
      render(recipient: TestRecipient): RenderedEmail {
        if (recipient.username === 'boom') {
          throw new TemplateRenderError('marker missing');
        }

        return { subject: 's', html: '<p>ok</p>' };
      }
    }

    const waiting = new WaitingProvider();
    const store = new FakeStateStore(emptyState('t'));

    await expect(
      runWith({
        records: [rec('a0@x.co', 'boom'), rec('b0@x.co'), rec('b1@x.co')],
        providers: new Map<string, EmailProvider>([
          ['a', new RecordingProvider()],
          ['b', waiting],
        ]),
        connectionIds: ['a', 'b'],
        store,
        renderer: new Broken(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof TemplateRunError && error.cause instanceof TemplateRenderError,
    );
    expect(waiting.sent).toEqual([]);
    expect(store.saved?.recipients).toEqual({});
    expect(store.appended.filter((entry) => entry.email === 'b0@x.co')).toEqual([
      { email: 'b0@x.co', intent: { at: 'NOW', connectionId: 'b' } },
      { email: 'b0@x.co', released: { at: 'NOW' } },
    ]);
  });

  it('an external abort lets the send in flight finish and leaves everyone else not attempted', async () => {
    const controller = new AbortController();

    class StopAfterFirst implements EmailProvider {
      readonly sent: string[] = [];
      async send(message: Message): Promise<void> {
        await Promise.resolve();
        this.sent.push(message.to);
        controller.abort();
      }
    }

    const provider = new StopAfterFirst();
    const store = new FakeStateStore(emptyState('t'));

    const { report } = await runWith({
      records: [rec('a@x.co'), rec('b@x.co'), rec('c@x.co')],
      providers: new Map([['x', provider]]),
      connectionIds: ['x'],
      store,
      signal: controller.signal,
    });

    expect(provider.sent).toEqual(['a@x.co']);
    expect(report).toMatchObject({ sent: 1, notAttempted: 2, failed: 0, uncertain: 0 });
    expect(Object.keys(store.saved?.recipients ?? {})).toEqual(['a@x.co']);
  });

  it('an already aborted signal sends nothing', async () => {
    const provider = new RecordingProvider();
    const { report } = await runWith({
      records: [rec('a@x.co'), rec('b@x.co')],
      providers: new Map([['x', provider]]),
      connectionIds: ['x'],
      signal: AbortSignal.abort(),
    });

    expect(provider.messages).toEqual([]);
    expect(report).toMatchObject({ sent: 0, notAttempted: 2 });
  });

  it('accounts for every planned recipient when a list stops on a fatal error', async () => {
    class BreaksOnThird implements TemplateRenderer<TestRecipient> {
      render(recipient: TestRecipient): RenderedEmail {
        if (recipient.username === 'boom') {
          throw new TemplateRenderError('marker missing');
        }

        return { subject: 's', html: '<p>ok</p>' };
      }
    }

    const provider = new RecordingProvider();

    const error: unknown = await runWith({
      records: [rec('a@x.co'), rec('b@x.co'), rec('c@x.co', 'boom'), rec('d@x.co')],
      providers: new Map([['x', provider]]),
      connectionIds: ['x'],
      renderer: new BreaksOnThird(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemplateRunError);
    const { report } = error as TemplateRunError;

    expect(report).toMatchObject({ total: 4, sent: 2, notAttempted: 2 });
    expect(report.results.filter((r) => r.status === 'not-attempted').map((r) => r.recipient)).toEqual([
      'c@x.co',
      'd@x.co',
    ]);
  });

  it('rejects an invalid CC or test inbox from an untyped caller before sending anything', async () => {
    const provider = new RecordingProvider();
    const base = {
      template: TEMPLATE,
      source: new FakeDataSource([rec('a@x.co')]),
      validator: new FakeValidator(),
      renderer: new CountingRenderer(),
      providers: new Map([['x', provider]]),
      connectionIds: ['x'],
      policy: { kind: 'pending' } as const,
      delayBetweenSendsMs: 0,
      stateStore: new FakeStateStore(emptyState('t')),
      logger: new SpyLogger(),
      sleeper: new ImmediateSleeper(),
      now: () => 'NOW',
    };

    await expect(
      runTemplate<TestRecipient>({ ...base, mode: { kind: 'live' }, cc: ['not-an-address' as EmailAddress] }),
    ).rejects.toThrow(/^cc\.0: email is not a valid address/);
    await expect(
      runTemplate<TestRecipient>({ ...base, mode: { kind: 'test', testRecipient: 7 as unknown as EmailAddress } }),
    ).rejects.toThrow('mode.testRecipient: email must be text');
    expect(provider.messages).toEqual([]);
  });

  it('sends to the normalized form of a CC given with surrounding spaces', async () => {
    const provider = new RecordingProvider();

    await runTemplate<TestRecipient>({
      template: TEMPLATE,
      source: new FakeDataSource([rec('a@x.co')]),
      validator: new FakeValidator(),
      renderer: new CountingRenderer(),
      providers: new Map([['x', provider]]),
      connectionIds: ['x'],
      policy: { kind: 'pending' },
      mode: { kind: 'live' },
      delayBetweenSendsMs: 0,
      stateStore: new FakeStateStore(emptyState('t')),
      logger: new SpyLogger(),
      sleeper: new ImmediateSleeper(),
      now: () => 'NOW',
      cc: [' boss@x.co ' as EmailAddress],
    });
    expect(provider.messages.map((m) => m.cc)).toEqual([['boss@x.co']]);
  });
});

describe('runTemplate when a history write fails', () => {
  const ENOSPC = 'Error: ENOSPC: no space left on device';

  it.each<{
    readonly stage: string;
    readonly failAppendAt: number;
    readonly provider: () => EmailProvider;
    readonly says: string;
    readonly neverSays: string;
  }>([
    {
      stage: 'intent',
      failAppendAt: 1,
      provider: () => new RecordingProvider(),
      says: 'did not call the provider',
      neverSays: 'check whether it was delivered',
    },
    {
      stage: 'outcome',
      failAppendAt: 2,
      provider: () => new RecordingProvider(),
      says: 'check whether it was delivered',
      neverSays: 'did not call the provider',
    },
    {
      stage: 'release',
      failAppendAt: 2,
      provider: () => new AuthFailProvider(),
      says: 'may not have been called',
      neverSays: 'did not call the provider',
    },
  ])(
    'at the $stage stage: says what happened, logs the recipient once, and keeps the journal',
    async ({ stage, failAppendAt, provider, says, neverSays }) => {
      const store = new FakeStateStore(emptyState('t'));
      const logger = new SpyLogger();

      store.failAppendAt = failAppendAt;

      const error: unknown = await runWith({
        records: [rec('a@x.co')],
        providers: new Map([['x', provider()]]),
        connectionIds: ['x'],
        store,
        logger,
      }).catch((caught: unknown) => caught);

      const cause = error instanceof TemplateRunError ? error.cause : undefined;
      const message = cause instanceof StatePersistenceError ? cause.message : '';

      expect(cause).toBeInstanceOf(StatePersistenceError);
      expect(message).toContain('could not record send state');
      expect(message).toContain(says);
      expect(message).not.toContain(neverSays);
      expect(message).toContain(ENOSPC);
      expect(logger.entries.filter((entry) => entry.event === 'recipient.unrecorded')).toEqual([
        {
          level: 'error',
          event: 'recipient.unrecorded',
          fields: { templateId: 't', connectionId: 'x', email: 'a@x.co', stage, error: ENOSPC },
        },
      ]);
      expect(logger.events()).toContain('state.journal_kept');
      expect(logger.events()).not.toContain('state.flush_failed');
      expect(store.saved).toBeUndefined();
    },
  );

  it('at compaction: names no recipient, says no outcome is lost, and logs no unrecorded recipient', async () => {
    const store = new FakeStateStore(emptyState('t'));
    const logger = new SpyLogger();

    store.failCompact = true;

    const error: unknown = await runWith({
      records: [rec('a@x.co')],
      providers: new Map([['x', new RecordingProvider()]]),
      connectionIds: ['x'],
      store,
      logger,
    }).catch((caught: unknown) => caught);

    const message = error instanceof StatePersistenceError ? error.message : '';

    expect(error).toBeInstanceOf(StatePersistenceError);
    expect(error).toMatchObject({ recipient: undefined });
    expect(message).toContain('no recorded outcome is lost');
    expect(message).not.toContain('a@x.co');
    expect(logger.events()).not.toContain('recipient.unrecorded');
  });
});
