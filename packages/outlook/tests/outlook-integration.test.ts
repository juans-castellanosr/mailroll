import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  type AuthProvider,
  type EmailAddress,
  type Logger,
  type Pacing,
  parseEmailAddress,
  type PreparedConnectionSender,
  type Recipient,
  type ResolvedTemplate,
  type RunReport,
  runTemplate,
  SignInRequiredError,
  type Sleeper,
  type SourceRecord,
  validateIntegrationDescriptor,
} from '@mailroll/core';
import type { FetchFn } from '../src/graph-client';
import { createOutlookIntegration } from '../src/outlook-integration';
import { FileStateStore } from 'mailroll';

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

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface GraphRequest {
  readonly to: string;
  readonly saveToSentItems: boolean;
  readonly authorization: string;
}

type Reply = Response | Error;

class FakeGraph {
  readonly requests: GraphRequest[] = [];
  constructor(private readonly reply: (index: number, to: string) => Reply) {}

  readonly fetch: FetchFn = (_input, init) => {
    const raw = init?.body;
    const body = JSON.parse(typeof raw === 'string' ? raw : '{}') as {
      message: { toRecipients: { emailAddress: { address: string } }[] };
      saveToSentItems: boolean;
    };
    const to = body.message.toRecipients[0]?.emailAddress.address ?? '';
    const headers = new Headers(init?.headers);

    this.requests.push({
      to,
      saveToSentItems: body.saveToSentItems,
      authorization: headers.get('authorization') ?? '',
    });

    const reply = this.reply(this.requests.length, to);

    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
}

const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });

class RecordingSleeper implements Sleeper {
  readonly waits: number[] = [];
  constructor(private readonly onSleep: () => void = () => undefined) {}
  sleep(ms: number): Promise<void> {
    this.waits.push(ms);
    this.onSleep();

    return Promise.resolve();
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-outlook-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function template(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  return {
    id: 't',
    campaignId: 'c',
    ccPolicy: 'optional',
    connectionIds: ['outlook-1'],
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

const signedIn: AuthProvider = { getAccessToken: () => Promise.resolve('TOKEN') };

async function outlook(graph: FakeGraph, auth: AuthProvider = signedIn): Promise<PreparedConnectionSender> {
  const checked = validateIntegrationDescriptor(
    createOutlookIntegration({ fetchFn: graph.fetch, authFor: () => auth }),
  );

  if (!checked.ok) {
    throw new Error(checked.reasons.join('; '));
  }

  const prepared = await checked.value.sender.prepare({
    connectionId: 'outlook-1',
    from: requireEmailAddress('sender@org.test', 'from'),
    settings: {},
    secrets: { TENANT_ID: 'tenant', CLIENT_ID: 'client' },
    stateDirectory: dir,
    stateKey: 'outlook_1',
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

class Source {
  constructor(private readonly emails: readonly string[]) {}
  async *read(): AsyncIterable<SourceRecord> {
    for (const email of this.emails) {
      await Promise.resolve();
      yield { email };
    }
  }
}

interface RunOptions {
  readonly sleeper?: Sleeper;
  readonly signal?: AbortSignal;
  readonly template?: ResolvedTemplate;
}

async function run(
  emails: readonly string[],
  sender: PreparedConnectionSender,
  options: RunOptions = {},
): Promise<RunReport> {
  const store = new FileStateStore();
  const list = options.template ?? template();
  const lock = await store.lock(list);

  try {
    return await runList(emails, sender, options, store, list);
  } finally {
    await lock.release();
  }
}

function runList(
  emails: readonly string[],
  sender: PreparedConnectionSender,
  options: RunOptions,
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
    renderer: { render: () => ({ subject: 's', html: '<p>x</p>' }) },
    providers: new Map(),
    senders: new Map([['outlook-1', sender]]),
    connectionIds: ['outlook-1'],
    policy: { kind: 'pending' },
    mode: { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: store,
    logger: silent,
    sleeper: options.sleeper ?? new RecordingSleeper(),
    now: () => '2026-11-12T00:00:00.000Z',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

const history = async () => (await new FileStateStore().load(template())).recipients;

describe('Microsoft Graph as a sender/0 integration', () => {
  it('passes the same public validation as any third-party integration', () => {
    const checked = validateIntegrationDescriptor(createOutlookIntegration());

    expect(checked.ok && checked.value).toMatchObject({
      id: 'outlook',
      configuration: {
        secrets: [
          { name: 'TENANT_ID', required: true, sensitive: false },
          { name: 'CLIENT_ID', required: true, sensitive: false },
        ],
      },
      sender: {
        capabilities: {
          cc: true,
          replyTo: true,
          inlineAttachments: true,
          sentCopy: 'optional',
          recipientAcceptance: 'transaction',
        },
      },
    });
  });

  it('records an accepted message after one request, signed with the connection token', async () => {
    const graph = new FakeGraph(() => status(202));
    const report = await run(['a@x.co'], await outlook(graph));

    expect(report).toMatchObject({ sent: 1 });
    expect(graph.requests).toEqual([{ to: 'a@x.co', saveToSentItems: false, authorization: 'Bearer TOKEN' }]);
  });

  it('records a refused message as a permanent failure with the existing text', async () => {
    const graph = new FakeGraph(() => status(400));

    await run(['a@x.co'], await outlook(graph));

    expect(graph.requests).toHaveLength(1);
    expect((await history())['a@x.co']).toMatchObject({
      status: 'failed',
      category: 'permanent',
      message: 'Microsoft Graph sendMail failed (HTTP 400)',
    });
  });

  it.each([
    ['a 5xx answer', () => status(500), 'Microsoft Graph sendMail failed (HTTP 500)'],
    ['a 408 answer', () => status(408), 'Microsoft Graph sendMail failed (HTTP 408)'],
    [
      'no answer in time',
      () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      'no answer from Microsoft Graph within 120 s; the message may or may not have been sent',
    ],
  ])('records %s as uncertain after exactly one request', async (_label, reply, message) => {
    const graph = new FakeGraph(reply);

    await run(['a@x.co'], await outlook(graph));

    expect(graph.requests).toHaveLength(1);
    expect((await history())['a@x.co']).toMatchObject({ status: 'uncertain', message });
  });

  it('lets the core retry throttling, once per request, honouring and capping Retry-After', async () => {
    const sleeper = new RecordingSleeper();
    const graph = new FakeGraph((index) => (index < 3 ? status(429, { 'retry-after': '9999' }) : status(202)));
    const report = await run(['a@x.co'], await outlook(graph), { sleeper });

    expect(report).toMatchObject({ sent: 1 });
    expect(graph.requests).toHaveLength(3);
    expect(sleeper.waits).toEqual([5_000, 5_000]);
  });

  it('never retries inside the integration: a request that keeps failing is sent only as often as the core calls', async () => {
    const graph = new FakeGraph(() => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));

    await run(['a@x.co'], await outlook(graph));

    expect(graph.requests).toHaveLength(PACING.maxRetries + 1);
    expect((await history())['a@x.co']).toMatchObject({ status: 'failed', category: 'transient' });
  });

  it.each([
    ['a 401 answer', new FakeGraph(() => status(401)), signedIn],
    [
      'a token that can no longer be refreshed',
      new FakeGraph(() => status(202)),
      ((): AuthProvider => {
        let calls = 0;

        return {
          getAccessToken: () => {
            calls += 1;

            return calls === 1 ? Promise.resolve('TOKEN') : Promise.reject(new Error('refresh token expired'));
          },
        };
      })(),
    ],
  ])('quarantines the connection on %s', async (_label, graph, auth) => {
    const report = await run(['a@x.co', 'b@x.co'], await outlook(graph, auth));

    expect(report).toMatchObject({ sent: 0, failed: 0, notAttempted: 2 });
    expect(report.results[0]).toMatchObject({
      reason: 'connection "outlook-1" quarantined (authentication failed); not attempted',
    });
    expect(await history()).toEqual({});
  });

  it('releases a recipient whose throttling wait was interrupted', async () => {
    const controller = new AbortController();
    const graph = new FakeGraph(() => status(429, { 'retry-after': '1' }));
    const report = await run(['a@x.co'], await outlook(graph), {
      sleeper: new RecordingSleeper(() => {
        controller.abort();
      }),
      signal: controller.signal,
    });

    expect(graph.requests).toHaveLength(1);
    expect(report).toMatchObject({ notAttempted: 1 });
    expect(await history()).toEqual({});
  });

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('sends saveToSentItems=%s from the template as %s on every request of an intent', async (save, expected) => {
    const graph = new FakeGraph((index) => (index === 1 ? status(429, { 'retry-after': '1' }) : status(202)));

    await run(['a@x.co'], await outlook(graph), {
      template: template(save === undefined ? {} : { saveToSentItems: save }),
    });

    expect(graph.requests.map((request) => request.saveToSentItems)).toEqual([expected, expected]);
  });
});

describe('the default Microsoft sign-in of the Outlook integration', () => {
  function prepareWith(interactive: boolean, signal: AbortSignal) {
    const checked = validateIntegrationDescriptor(
      createOutlookIntegration({ fetchFn: new FakeGraph(() => status(202)).fetch }),
    );

    if (!checked.ok) {
      throw new Error(checked.reasons.join('; '));
    }

    return checked.value.sender.prepare({
      connectionId: 'outlook-1',
      from: requireEmailAddress('sender@org.test', 'from'),
      settings: {},
      secrets: { TENANT_ID: '00000000-0000-0000-0000-000000000001', CLIENT_ID: '00000000-0000-0000-0000-000000000002' },
      stateDirectory: dir,
      stateKey: 'outlook_1',
      interaction: { announce: () => undefined },
      interactive,
      signal,
      logger: silent,
    });
  }

  it('refuses to wait for a person when the run is not interactive and nothing is saved', async () => {
    await expect(prepareWith(false, new AbortController().signal)).rejects.toThrow(
      new SignInRequiredError(
        'no saved sign-in for sender@org.test (connection "outlook-1"); run mailroll once in a terminal to sign in',
      ),
    );
  });

  it('honours a run that was already stopped instead of starting a device-code sign-in', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(prepareWith(true, controller.signal)).rejects.toThrow(
      new AuthError('sign-in for connection "outlook-1" was canceled'),
    );
  });
});
