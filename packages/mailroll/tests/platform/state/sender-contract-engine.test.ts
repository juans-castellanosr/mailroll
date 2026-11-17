import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  type DataSource,
  type EmailAddress,
  INTEGRATION_KIND,
  type LogFields,
  type Logger,
  type Message,
  type Pacing,
  parseEmailAddress,
  type PreparedConnectionSender,
  type Recipient,
  type RecipientJournalEntry,
  type RenderedEmail,
  type ResolvedTemplate,
  type RunReport,
  runTemplate,
  type RunTemplateDeps,
  type SendAttempt,
  SendCancelledError,
  SENDER_CONTRACT,
  type SenderCapabilities,
  SendError,
  type SendPreferences,
  type Sleeper,
  type SourceRecord,
  valid,
  validateIntegrationDescriptor,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { withLock } from '../../support/write-access';

function requireEmailAddress(value: string, field: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error(`${field}: ${outcome.reasons.join('; ')}`);
  }

  return outcome.value;
}

const PACING: Pacing = {
  delayBetweenSendsMs: 0,
  maxRetries: 2,
  baseBackoffMs: 10,
  maxBackoffMs: 10,
  maxRetryAfterMs: 5_000,
  maxThrottleWaitMs: 12_000,
};

const CAPABILITIES: SenderCapabilities = {
  cc: true,
  replyTo: true,
  inlineAttachments: true,
  sentCopy: 'optional',
  recipientAcceptance: 'transaction',
};

interface Call {
  readonly to: string;
  readonly attempt: SendAttempt;
  readonly preferences: SendPreferences;
}

type Script = (message: Message, attempt: SendAttempt) => unknown;

class FakeSender {
  readonly calls: Call[] = [];
  constructor(private readonly script: Script) {}

  accepted(): string[] {
    return this.calls.filter((_call, index) => this.results[index] === 'accepted').map((call) => call.to);
  }

  private readonly results: string[] = [];

  async prepare(capabilities: SenderCapabilities = CAPABILITIES): Promise<PreparedConnectionSender> {
    const checked = validateIntegrationDescriptor({
      kind: INTEGRATION_KIND,
      id: 'fake-sender',
      version: '1.0.0',
      configuration: { secrets: [], validateSettings: (raw: unknown) => valid(raw) },
      roles: {
        sender: {
          contract: SENDER_CONTRACT,
          capabilities,
          prepare: () =>
            Promise.resolve({
              send: (message: Message, attempt: SendAttempt, preferences: SendPreferences) => {
                this.calls.push({ to: message.to, attempt, preferences });

                const outcome = this.script(message, attempt);

                this.results.push(
                  typeof outcome === 'object' && outcome !== null && 'outcome' in outcome
                    ? String(outcome.outcome)
                    : '?',
                );

                return outcome;
              },
              close: () => Promise.resolve(),
            }),
        },
      },
    });

    if (!checked.ok) {
      throw new Error(checked.reasons.join('; '));
    }

    const prepared = await checked.value.sender.prepare({
      connectionId: 'acme-1',
      from: requireEmailAddress('noreply@acme.test', 'from'),
      stateKey: 'acme_1',
      settings: {},
      secrets: {},
      stateDirectory: dir,
      interaction: { announce: () => undefined },
      interactive: false,
      signal: new AbortController().signal,
      logger: silent,
    });

    if (!prepared.ok) {
      throw new Error(prepared.reasons.join('; '));
    }

    return { capabilities: checked.value.sender.capabilities, sender: prepared.value };
  }
}

const accepted = () => ({ outcome: 'accepted' });
const rejected = (reason: string, scope: string, extra: Record<string, unknown> = {}) => ({
  outcome: 'not-accepted',
  reason,
  scope,
  detail: `${reason}/${scope}`,
  ...extra,
});

class Events implements Logger {
  readonly entries: { event: string; fields?: LogFields }[] = [];
  info(event: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { event } : { event, fields });
  }

  warn(event: string, fields?: LogFields): void {
    this.info(event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.info(event, fields);
  }
}

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class RecordingSleeper implements Sleeper {
  readonly waits: number[] = [];
  constructor(private readonly onSleep: () => void = () => undefined) {}
  sleep(ms: number): Promise<void> {
    this.waits.push(ms);
    this.onSleep();

    return Promise.resolve();
  }
}

class Source implements DataSource {
  constructor(private readonly emails: readonly string[]) {}
  async *read(): AsyncIterable<SourceRecord> {
    for (const email of this.emails) {
      await Promise.resolve();
      yield { email };
    }
  }
}

class DyingStore extends FileStateStore {
  private writes = 0;
  constructor(private readonly dieAt: number) {
    super();
  }

  override async append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    this.writes += 1;

    if (this.writes === this.dieAt) {
      throw new Error('process killed');
    }

    await super.append(template, entry);
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-sender-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function template(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return {
    id: 't',
    campaignId: 'c',
    ccPolicy: 'optional',
    connectionIds: ['x', 'y'],
    dir,
    dataDir: dir,
    stateDir: dir,
    assetsDir: dir,
    compiledHtmlPath: '',
    context: {},
    dataFile: 'list.csv',
    dataPath: '',
    statePath: join(dir, 'list.json'),
    pacing: PACING,
    ...overrides,
  };
}

interface Options {
  readonly senders: ReadonlyMap<string, PreparedConnectionSender>;
  readonly connectionIds?: readonly string[];
  readonly sleeper?: Sleeper;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly cc?: readonly EmailAddress[];
  readonly template?: ResolvedTemplate;
  readonly store?: FileStateStore;
  readonly render?: () => RenderedEmail;
  readonly extra?: Partial<RunTemplateDeps<Recipient>>;
}

let attempts = 0;

async function run(emails: readonly string[], options: Options): Promise<RunReport> {
  const store = options.store ?? new FileStateStore();
  const list = options.template ?? template();

  return withLock(store, list, () => runList(emails, options, store, list));
}

function runList(
  emails: readonly string[],
  options: Options,
  store: FileStateStore,
  list: ResolvedTemplate,
): Promise<RunReport> {
  return runTemplate<Recipient>({
    template: list,
    source: new Source(emails),
    validator: {
      validate: (record) => {
        const email = parseEmailAddress(record['email'] ?? '');

        return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
      },
    },
    renderer: { render: options.render ?? (() => ({ subject: 's', html: '<p>x</p>' })) },
    providers: new Map(),
    senders: options.senders,
    connectionIds: options.connectionIds ?? ['x'],
    policy: { kind: 'pending' },
    mode: { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: store,
    logger: options.logger ?? silent,
    sleeper: options.sleeper ?? new RecordingSleeper(),
    now: () => '2026-11-12T00:00:00.000Z',
    newAttemptId: () => {
      attempts += 1;

      return `attempt-${String(attempts)}`;
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.cc !== undefined ? { cc: options.cc } : {}),
    ...options.extra,
  });
}

const history = async () => (await new FileStateStore().load(template())).recipients;

describe('the engine on the sender/0 contract', () => {
  it('records an accepted send and gives each intent its own attempt id', async () => {
    const sender = new FakeSender(accepted);
    const report = await run(['a@x.co', 'b@x.co'], { senders: new Map([['x', await sender.prepare()]]) });

    expect(report).toMatchObject({ sent: 2 });
    expect((await history())['a@x.co']).toMatchObject({ status: 'sent', connectionId: 'x' });
    expect(sender.calls.map((call) => call.attempt.call)).toEqual([1, 1]);
    expect(new Set(sender.calls.map((call) => call.attempt.attemptId)).size).toBe(2);
  });

  it('retries a certain transient rejection under the same intent and records one acceptance', async () => {
    const sender = new FakeSender((_message, attempt) =>
      attempt.call === 1 ? rejected('transient', 'message') : accepted(),
    );
    const report = await run(['a@x.co'], { senders: new Map([['x', await sender.prepare()]]) });

    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.calls.map((call) => call.attempt)).toEqual([
      { attemptId: sender.calls[0]?.attempt.attemptId, call: 1 },
      { attemptId: sender.calls[0]?.attempt.attemptId, call: 2 },
    ]);
    expect(sender.accepted()).toEqual(['a@x.co']);
  });

  it('records an exhausted transient rejection as failed, and the next run sends it again', async () => {
    const sender = new FakeSender(() => rejected('transient', 'message'));

    await run(['a@x.co'], { senders: new Map([['x', await sender.prepare()]]) });

    expect(sender.calls).toHaveLength(PACING.maxRetries + 1);
    expect((await history())['a@x.co']).toMatchObject({ status: 'failed', category: 'transient' });

    const second = new FakeSender(accepted);

    await run(['a@x.co'], { senders: new Map([['x', await second.prepare()]]) });
    expect(second.accepted()).toEqual(['a@x.co']);
  });

  it('caps a huge throttling hint at maxRetryAfterMs and stops at the throttling budget', async () => {
    const sleeper = new RecordingSleeper();
    const sender = new FakeSender(() => rejected('throttled', 'message', { retryAfterMs: 1e12 }));

    await run(['a@x.co'], { senders: new Map([['x', await sender.prepare()]]), sleeper });

    expect(sleeper.waits).toEqual([5_000, 5_000]);
    expect((await history())['a@x.co']).toMatchObject({
      status: 'failed',
      category: 'throttled',
      message: 'throttled/message — still throttled after waiting 10 s (limit 12 s)',
    });
  });

  it('records a permanent message rejection and moves on to the next recipient', async () => {
    const sender = new FakeSender((message) =>
      message.to === 'a@x.co' ? rejected('permanent', 'message') : accepted(),
    );
    const report = await run(['a@x.co', 'b@x.co'], { senders: new Map([['x', await sender.prepare()]]) });

    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(sender.calls).toHaveLength(2);
  });

  it('stops only the connection a connection-wide rejection affects; the other connection sends everything', async () => {
    const broken = new FakeSender(() => rejected('permanent', 'connection'));
    const healthy = new FakeSender(accepted);
    const report = await run(['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co'], {
      senders: new Map([
        ['x', await broken.prepare()],
        ['y', await healthy.prepare()],
      ]),
      connectionIds: ['x', 'y'],
    });

    expect(broken.calls).toHaveLength(1);
    expect(healthy.accepted()).toEqual(['b@x.co', 'd@x.co']);
    expect(report).toMatchObject({ sent: 2, notAttempted: 2, failed: 0, uncertain: 0 });
    expect(Object.keys(await history()).sort()).toEqual(['b@x.co', 'd@x.co']);
    expect(report.results).toContainEqual(
      expect.objectContaining({
        status: 'not-attempted',
        recipient: 'a@x.co',
        reason: 'connection "x" stopped (permanent/connection); not attempted',
      }),
    );
  });

  it('retries a transient connection-wide rejection, then stops that connection without recording a failure', async () => {
    const sender = new FakeSender(() => rejected('transient', 'connection'));
    const report = await run(['a@x.co', 'b@x.co'], { senders: new Map([['x', await sender.prepare()]]) });

    expect(sender.calls).toHaveLength(PACING.maxRetries + 1);
    expect(report).toMatchObject({ failed: 0, notAttempted: 2 });
    expect(await history()).toEqual({});
  });

  it('quarantines the connection on an auth rejection with the existing message', async () => {
    const logger = new Events();
    const sender = new FakeSender(() => rejected('auth', 'connection'));
    const report = await run(['a@x.co', 'b@x.co'], { senders: new Map([['x', await sender.prepare()]]), logger });

    expect(sender.calls).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      status: 'not-attempted',
      reason: 'connection "x" quarantined (authentication failed); not attempted',
    });
    expect(logger.entries.map((entry) => entry.event)).toContain('connection.quarantined');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'recipient.auth_failed',
        fields: expect.objectContaining({ connectionId: 'x', email: 'a@x.co' }) as unknown,
      }),
    );
  });

  it.each([
    ['an unknown result', () => ({ outcome: 'unknown', detail: 'timeout after the content' })],
    ['a malformed result', () => ({ outcome: 'not-accepted', reason: 'transient', scope: 'nowhere', detail: 'x' })],
    ['a send that throws', () => Promise.reject(new Error('socket closed'))],
  ])('records %s as uncertain after one call and never sends it again', async (_label, script) => {
    const sender = new FakeSender(script);

    await run(['a@x.co'], { senders: new Map([['x', await sender.prepare()]]) });

    expect(sender.calls).toHaveLength(1);
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain' });

    const second = new FakeSender(accepted);
    const report = await run(['a@x.co'], { senders: new Map([['x', await second.prepare()]]) });

    expect(second.calls).toEqual([]);
    expect(report).toMatchObject({ heldUncertain: 1 });
  });

  it('stops a connection after three unknown results in a row', async () => {
    const sender = new FakeSender(() => ({ outcome: 'unknown', detail: 'no answer' }));
    const report = await run(['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co'], {
      senders: new Map([['x', await sender.prepare()]]),
    });

    expect(sender.calls).toHaveLength(3);
    expect(report).toMatchObject({ uncertain: 3, notAttempted: 1 });
  });

  it('releases a recipient whose retry wait was interrupted, and the next run sends it once', async () => {
    const controller = new AbortController();
    const sender = new FakeSender(() => rejected('transient', 'message'));
    const report = await run(['a@x.co'], {
      senders: new Map([['x', await sender.prepare()]]),
      sleeper: new RecordingSleeper(() => {
        controller.abort();
      }),
      signal: controller.signal,
    });

    expect(sender.calls).toHaveLength(1);
    expect(report).toMatchObject({ notAttempted: 1 });
    expect(await history()).toEqual({});

    const second = new FakeSender(accepted);

    await run(['a@x.co'], { senders: new Map([['x', await second.prepare()]]) });
    expect(second.accepted()).toEqual(['a@x.co']);
  });

  it('marks a recipient uncertain after a crash between its send and its record', async () => {
    const sender = new FakeSender(accepted);

    await expect(
      run(['a@x.co', 'b@x.co'], { senders: new Map([['x', await sender.prepare()]]), store: new DyingStore(2) }),
    ).rejects.toThrow(/could not record send state/);
    expect(sender.accepted()).toEqual(['a@x.co']);
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain' });
  });

  it.each([
    [{ ...CAPABILITIES, cc: false }, {}, 'its integration cannot send CC, and this list has a CC'],
    [{ ...CAPABILITIES, maxCc: 1 }, {}, 'its integration accepts at most 1 CC, and this list has 2'],
    [
      { ...CAPABILITIES, sentCopy: 'never' as const },
      { saveToSentItems: true },
      'the template asks to save a copy in Sent Items, and its integration never keeps one',
    ],
  ])('sends nothing on a connection that cannot send this list (%#)', async (capabilities, templateOverrides, rule) => {
    const sender = new FakeSender(accepted);
    const report = await run(['a@x.co'], {
      senders: new Map([['x', await sender.prepare(capabilities)]]),
      cc: [requireEmailAddress('boss@x.co', 'cc'), requireEmailAddress('team@x.co', 'cc')],
      template: template(templateOverrides),
    });

    expect(sender.calls).toEqual([]);
    expect(report.results).toEqual([
      {
        status: 'not-attempted',
        recipient: 'a@x.co',
        reason: `connection "x" cannot send this list: ${rule}; not attempted`,
      },
    ]);
  });

  it('does not hand a message with inline images to an integration that cannot send them', async () => {
    const sender = new FakeSender(accepted);
    const report = await run(['a@x.co'], {
      senders: new Map([['x', await sender.prepare({ ...CAPABILITIES, inlineAttachments: false })]]),
      render: () => ({
        subject: 's',
        html: '<img src="cid:logo">',
        inlineAttachments: [{ cid: 'logo', filename: 'logo.png', contentType: 'image/png', contentBase64: 'AA==' }],
      }),
    });

    expect(sender.calls).toEqual([]);
    expect(report).toMatchObject({ notAttempted: 1 });
    expect(await history()).toEqual({});
  });

  it('records the send and reports an observed CC rejection without retrying anyone', async () => {
    const logger = new Events();
    const sender = new FakeSender(() => ({ outcome: 'accepted', ccRejected: ['boss@x.co'] }));
    const report = await run(['a@x.co'], {
      senders: new Map([['x', await sender.prepare({ ...CAPABILITIES, recipientAcceptance: 'per-recipient' })]]),
      cc: [requireEmailAddress('boss@x.co', 'cc')],
      logger,
    });

    expect(report).toMatchObject({ sent: 1 });
    expect(sender.calls).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'recipient.cc_rejected',
        fields: expect.objectContaining({ cc: 'boss@x.co' }) as unknown,
      }),
    );
  });

  it('refuses a connection bound both to a legacy provider and to a sender', async () => {
    const sender = new FakeSender(accepted);

    await expect(
      run(['a@x.co'], {
        senders: new Map([['x', await sender.prepare()]]),
        extra: { providers: new Map([['x', { send: () => Promise.resolve() }]]) },
      }),
    ).rejects.toThrow(ConfigError);
    expect(sender.calls).toEqual([]);
  });

  it('refuses a dry run with senders, because a sender would send for real', async () => {
    const sender = new FakeSender(accepted);

    await expect(
      run(['a@x.co'], { senders: new Map([['x', await sender.prepare()]]), extra: { mode: { kind: 'dry-run' } } }),
    ).rejects.toThrow('a dry run never uses senders');
    expect(sender.calls).toEqual([]);
  });

  it('refuses an invalid pacing instead of retrying without limit', async () => {
    const sender = new FakeSender(() => rejected('transient', 'message'));

    await expect(
      run(['a@x.co'], {
        senders: new Map([['x', await sender.prepare()]]),
        template: template({ pacing: { ...PACING, maxRetries: Number.NaN } }),
      }),
    ).rejects.toThrow('"maxRetries" must be a finite number of zero or more');
    expect(sender.calls).toEqual([]);
  });
});

describe('the engine on a legacy email provider', () => {
  const legacy = (send: (message: Message, options?: { signal?: AbortSignal }) => Promise<void>) => ({ send });

  async function runLegacy(emails: readonly string[], provider: ReturnType<typeof legacy>, signal?: AbortSignal) {
    return run(emails, {
      senders: new Map(),
      extra: { providers: new Map([['x', provider]]), ...(signal === undefined ? {} : { signal }) },
    });
  }

  it.each([
    ['transient', new SendError('could not reach the provider', 'transient')],
    ['throttled', new SendError('slow down', 'throttled', { retryAfterMs: 1_000 })],
  ])('records a %s SendError after one call: retries stay inside the provider', async (category, error) => {
    let calls = 0;
    const report = await runLegacy(
      ['a@x.co'],
      legacy(() => {
        calls += 1;

        return Promise.reject(error);
      }),
    );

    expect(calls).toBe(1);
    expect(report).toMatchObject({ failed: 1 });
    expect((await history())['a@x.co']).toMatchObject({ status: 'failed', category, message: error.message });
  });

  it('describes a SendError that has no message instead of storing an empty one', async () => {
    await runLegacy(
      ['a@x.co'],
      legacy(() => Promise.reject(new SendError('', 'permanent'))),
    );

    expect((await history())['a@x.co']).toMatchObject({
      status: 'failed',
      category: 'permanent',
      message: 'the provider reported a permanent failure',
    });
  });

  it('records a send that was already in flight when the run stopped as uncertain', async () => {
    const controller = new AbortController();
    const report = await runLegacy(
      ['a@x.co', 'b@x.co'],
      legacy(() => {
        controller.abort();

        return Promise.reject(new SendCancelledError('aborted mid-request'));
      }),
      controller.signal,
    );

    expect(report).toMatchObject({ uncertain: 1, notAttempted: 1 });
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain' });
    expect(report.results).toContainEqual({
      status: 'not-attempted',
      recipient: 'b@x.co',
      reason: 'run stopped before this send; not attempted',
    });
  });
});

describe('the engine boundary against senders that skipped validation', () => {
  const untyped = (raw: unknown): ReadonlyMap<string, PreparedConnectionSender> =>
    new Map([['x', raw]]) as unknown as ReadonlyMap<string, PreparedConnectionSender>;

  function handMade(send: (message: Message, attempt: SendAttempt) => unknown, capabilities: unknown = CAPABILITIES) {
    const calls: string[] = [];

    return {
      calls,
      binding: {
        capabilities,
        sender: {
          send: (message: Message, attempt: SendAttempt) => {
            calls.push(message.to);

            return send(message, attempt);
          },
        },
      },
    };
  }

  it('does not trust an unvalidated acceptance: a missing observed-CC list makes it uncertain', async () => {
    const fake = handMade(() => ({ outcome: 'accepted' }), { ...CAPABILITIES, recipientAcceptance: 'per-recipient' });
    const report = await run(['a@x.co'], {
      senders: untyped(fake.binding),
      cc: [requireEmailAddress('boss@x.co', 'cc')],
    });

    expect(fake.calls).toEqual(['a@x.co']);
    expect(report).toMatchObject({ sent: 0, failed: 0, uncertain: 1 });
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain' });
  });

  it.each([
    [
      'a send that throws synchronously',
      () => {
        throw new Error('bad state');
      },
    ],
    ['a rejected promise', () => Promise.reject(new Error('socket closed'))],
    ['a result that is not an outcome', () => 'sent!'],
    [
      'a rejection that claims a certainty it does not describe',
      () => ({ outcome: 'not-accepted', reason: 'transient' }),
    ],
  ])('records %s as uncertain for that recipient only, and keeps sending', async (_label, failure) => {
    const fake = handMade((message) => (message.to === 'a@x.co' ? failure() : { outcome: 'accepted' }));
    const report = await run(['a@x.co', 'b@x.co'], { senders: untyped(fake.binding) });

    expect(fake.calls).toEqual(['a@x.co', 'b@x.co']);
    expect(report).toMatchObject({ sent: 1, failed: 0, uncertain: 1 });
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain' });
    expect((await history())['b@x.co']).toMatchObject({ status: 'sent' });
  });

  it.each([
    [
      'incoherent capabilities',
      { capabilities: { ...CAPABILITIES, cc: false, maxCc: 2 }, sender: { send: () => ({ outcome: 'accepted' }) } },
      '"roles.sender.capabilities.maxCc" only makes sense when "cc" is true',
    ],
    [
      'an unknown recipient acceptance',
      { capabilities: { ...CAPABILITIES, recipientAcceptance: 'sometimes' }, sender: { send: () => ({}) } },
      '"roles.sender.capabilities.recipientAcceptance" must be one of',
    ],
    [
      'a send that is not a function',
      { capabilities: CAPABILITIES, sender: { send: 'go' } },
      '"sender.send" must be a function',
    ],
    ['a binding that is not an object', 'sender', 'the binding is not an object'],
  ])('refuses a binding with %s before sending anything', async (_label, binding, reason) => {
    await expect(run(['a@x.co'], { senders: untyped(binding) })).rejects.toThrow(
      new RegExp(`the sender bound to connection "x" is invalid: .*${reason.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}`),
    );
    expect(await history()).toEqual({});
  });
});

describe('pacing validation for sender connections', () => {
  const pacingOf = (raw: unknown): Pacing => raw as Pacing;
  const without = (name: keyof Pacing) => Object.fromEntries(Object.entries(PACING).filter(([key]) => key !== name));

  type PacingCase = readonly [label: string, pacing: unknown, reason: string];
  const REQUIRED: readonly (keyof Pacing)[] = [
    'delayBetweenSendsMs',
    'maxRetries',
    'baseBackoffMs',
    'maxBackoffMs',
    'maxRetryAfterMs',
    'maxThrottleWaitMs',
  ];
  const cases: readonly PacingCase[] = [
    ...REQUIRED.map((name): PacingCase => [
      `a missing "${name}"`,
      without(name),
      `"${name}" must be a finite number of zero or more`,
    ]),
    ['NaN', { ...PACING, maxBackoffMs: Number.NaN }, '"maxBackoffMs" must be a finite number of zero or more'],
    [
      'Infinity',
      { ...PACING, maxThrottleWaitMs: Infinity },
      '"maxThrottleWaitMs" must be a finite number of zero or more',
    ],
    ['a negative value', { ...PACING, baseBackoffMs: -1 }, '"baseBackoffMs" must be a finite number of zero or more'],
    ['a fractional retry count', { ...PACING, maxRetries: 1.5 }, '"maxRetries" must be a whole number'],
    [
      'text instead of a number',
      { ...PACING, maxRetries: '3' },
      '"maxRetries" must be a finite number of zero or more',
    ],
    ['something that is not an object', 'fast', 'the pacing is not an object'],
  ];

  it.each(cases)('refuses %s with a clear error and sends nothing', async (_label, pacing, reason) => {
    const sender = new FakeSender(() => rejected('transient', 'message'));

    await expect(
      run(['a@x.co'], {
        senders: new Map([['x', await sender.prepare()]]),
        template: template({ pacing: pacingOf(pacing) }),
      }),
    ).rejects.toThrow(reason);
    expect(sender.calls).toEqual([]);
  });
});

describe('the sent-copy preference', () => {
  it.each([
    ['optional', true, true],
    ['optional', false, false],
    ['always', false, false],
    ['always', true, true],
  ] as const)(
    'passes keepSentCopy from the template to a %s sender (saveToSentItems %s → %s) on every call of an intent',
    async (sentCopy, saveToSentItems, expected) => {
      const sender = new FakeSender((_message, attempt) =>
        attempt.call === 1 ? rejected('transient', 'message') : accepted(),
      );

      await run(['a@x.co'], {
        senders: new Map([['x', await sender.prepare({ ...CAPABILITIES, sentCopy })]]),
        template: template({ saveToSentItems }),
      });

      expect(sender.calls.map((call) => call.preferences)).toEqual([
        { keepSentCopy: expected },
        { keepSentCopy: expected },
      ]);
    },
  );
});

describe('the history files written by a run', () => {
  it('keeps the attempt id, provider id and rejected CC with their policy in the v2 snapshot', async () => {
    const evidence = new FakeSender(() => ({ outcome: 'accepted', providerMessageId: 'p-1', ccRejected: ['cc@x.co'] }));
    const report = await run(['a@x.co'], {
      senders: new Map([['x', await evidence.prepare({ ...CAPABILITIES, recipientAcceptance: 'per-recipient' })]]),
      cc: [requireEmailAddress('cc@x.co', 'cc')],
    });
    const snapshot: unknown = JSON.parse(readFileSync(join(dir, 'list.json'), 'utf8'));

    expect(report).toMatchObject({ sent: 1, ccRejectedMessages: 1 });
    expect(snapshot).toEqual({
      version: 2,
      templateId: 't',
      recipients: {
        'a@x.co': {
          status: 'sent',
          at: '2026-11-12T00:00:00.000Z',
          connectionId: 'x',
          attemptId: `attempt-${String(attempts)}`,
          providerMessageId: 'p-1',
          cc: { rejected: ['cc@x.co'], required: false },
        },
      },
      updatedAt: '2026-11-12T00:00:00.000Z',
    });
  });

  it('writes a v2 journal with the attempt ids when a run stops before compacting', async () => {
    const sender = new FakeSender(() => accepted());

    await expect(
      run(['a@x.co', 'b@x.co'], {
        senders: new Map([['x', await sender.prepare()]]),
        store: new DyingStore(4),
      }),
    ).rejects.toThrow(/could not record send state/);

    const lines = readFileSync(join(dir, 'list.jsonl'), 'utf8').trim().split('\n');

    expect(lines[0]).toBe('{"format":"mailroll-journal","version":2}');
    expect(lines.slice(1).map((line) => Object.keys(JSON.parse(line) as object)[1])).toEqual([
      'intent',
      'status',
      'intent',
    ]);
    expect(lines.slice(1).every((line) => line.includes(`"attemptId":"attempt-`))).toBe(true);
  });
});

describe('recovering from a crash with the v2 history on disk', () => {
  it('records an accepted send whose outcome could not be written as uncertain with its attempt id, and never sends it again by itself', async () => {
    const sender = new FakeSender(() => accepted());
    const prepared = await sender.prepare();

    await expect(run(['a@x.co'], { senders: new Map([['x', prepared]]), store: new DyingStore(2) })).rejects.toThrow(
      /could not record send state/,
    );

    const firstAttempt = sender.calls[0]?.attempt.attemptId;

    expect(sender.accepted()).toEqual(['a@x.co']);
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain', attemptId: firstAttempt });

    const next = await run(['a@x.co'], { senders: new Map([['x', prepared]]) });

    expect(next).toMatchObject({ heldUncertain: 1, sent: 0 });
    expect(sender.calls).toHaveLength(1);
  });

  it('keeps every uncertain attempt across deliberate resends, compactions and reopening', async () => {
    const outcomes: unknown[] = [
      { outcome: 'unknown', detail: 'reset' },
      { outcome: 'unknown', detail: 'reset' },
      accepted(),
    ];
    const sender = new FakeSender(() => outcomes.shift());
    const prepared = await sender.prepare();
    const subset = { policy: { kind: 'subset', recipients: [requireEmailAddress('a@x.co', 'subset')] } } as const;

    await run(['a@x.co'], { senders: new Map([['x', prepared]]) });
    await run(['a@x.co'], { senders: new Map([['x', prepared]]), extra: subset });
    await run(['a@x.co'], { senders: new Map([['x', prepared]]), extra: subset });

    const ids = sender.calls.map((call) => call.attempt.attemptId);
    const snapshot = JSON.parse(readFileSync(join(dir, 'list.json'), 'utf8')) as {
      recipients: Record<string, unknown>;
    };

    expect(snapshot.recipients['a@x.co']).toMatchObject({
      status: 'sent',
      attemptId: ids[2],
      uncertainAttemptIds: [ids[0], ids[1]],
    });
    expect((await history())['a@x.co']).toEqual(snapshot.recipients['a@x.co']);
  });
});
