import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DataSource,
  DEFAULT_PACING,
  type EmailProvider,
  type Message,
  parseEmailAddress,
  type Recipient,
  type ResolvedTemplate,
  RetryingEmailProvider,
  type RunReport,
  runTemplate,
  SendCancelledError,
  SendError,
  type Sleeper,
  type SourceRecord,
} from '@mailroll/core';
import type * as CoreModule from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { withLock } from '../../support/write-access';

type ErrorsModule = typeof CoreModule;

async function foreignErrors(): Promise<ErrorsModule> {
  vi.resetModules();

  const foreign = await import('@mailroll/core');

  expect(foreign.SendError).not.toBe(SendError);
  expect(foreign.SendCancelledError).not.toBe(SendCancelledError);

  return foreign;
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

interface Step {
  readonly deliver: boolean;
  readonly error?: Error;
}

class ScriptedProvider implements EmailProvider {
  readonly delivered: string[] = [];
  private calls = 0;
  constructor(private readonly script: (to: string, call: number) => Step = () => ({ deliver: true })) {}

  async send(message: Message): Promise<void> {
    await Promise.resolve();
    this.calls += 1;

    const step = this.script(message.to, this.calls);

    if (step.deliver) {
      this.delivered.push(message.to);
    }

    if (step.error !== undefined) {
      throw step.error;
    }
  }
}

const instantSleeper: Sleeper = { sleep: () => Promise.resolve() };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-outcome-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function template(): ResolvedTemplate {
  return {
    id: 't',
    campaignId: 'c',
    ccPolicy: 'optional',
    connectionIds: ['x'],
    dir,
    dataDir: dir,
    stateDir: dir,
    assetsDir: dir,
    compiledHtmlPath: '',
    context: {},
    dataFile: 'list.csv',
    dataPath: '',
    statePath: join(dir, 'list.json'),
  };
}

interface RunOptions {
  readonly signal?: AbortSignal;
}

async function run(provider: EmailProvider, emails: readonly string[], options: RunOptions = {}): Promise<RunReport> {
  const store = new FileStateStore();

  return withLock(store, template(), () => runList(provider, emails, options, store));
}

function runList(
  provider: EmailProvider,
  emails: readonly string[],
  options: RunOptions,
  store: FileStateStore,
): Promise<RunReport> {
  return runTemplate<Recipient>({
    template: template(),
    source: new Source(emails),
    validator: {
      validate: (record) => {
        const email = parseEmailAddress(record['email'] ?? '');

        return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
      },
    },
    renderer: { render: () => ({ subject: 's', html: '<p>x</p>' }) },
    providers: new Map([['x', provider]]),
    connectionIds: ['x'],
    policy: { kind: 'pending' },
    mode: { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleeper: instantSleeper,
    now: () => '2026-11-12T00:00:00.000Z',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

const savedState = () => new FileStateStore().load(template());

function deliveriesTo(email: string, ...providers: readonly ScriptedProvider[]): number {
  return providers.flatMap((p) => p.delivered).filter((to) => to === email).length;
}

const EMAILS = ['a@x.co', 'b@x.co'] as const;

async function expectHeldOnTheNextRun(first: ScriptedProvider): Promise<void> {
  const state = await savedState();

  expect(state.recipients['a@x.co']).toMatchObject({ status: 'uncertain', connectionId: 'x' });
  expect(existsSync(join(dir, 'list.jsonl'))).toBe(false);

  const second = new ScriptedProvider();
  const report = await run(second, EMAILS);

  expect(second.delivered).toEqual([]);
  expect(report).toMatchObject({ sent: 0, heldUncertain: 1 });
  expect(deliveriesTo('a@x.co', first, second)).toBe(1);
}

describe('send outcomes the engine cannot verify', () => {
  it('records an unrecognized error thrown after a possible acceptance as uncertain and never re-sends it', async () => {
    const first = new ScriptedProvider((to) =>
      to === 'a@x.co' ? { deliver: true, error: new Error('could not read the response body') } : { deliver: true },
    );

    const report = await run(first, EMAILS);

    expect(report).toMatchObject({ sent: 1, uncertain: 1, failed: 0 });
    expect((await savedState()).recipients['a@x.co']).toMatchObject({
      status: 'uncertain',
      message:
        'unexpected send failure: Error: could not read the response body; the message may or may not have been sent',
    });
    await expectHeldOnTheNextRun(first);
  });

  it('honours an uncertain SendError thrown by another copy of mailroll', async () => {
    const foreign = await foreignErrors();
    const first = new ScriptedProvider((to) =>
      to === 'a@x.co' ? { deliver: true, error: new foreign.SendError('HTTP 504', 'uncertain') } : { deliver: true },
    );

    const report = await run(first, EMAILS);

    expect(report).toMatchObject({ sent: 1, uncertain: 1, failed: 0 });
    expect((await savedState()).recipients['a@x.co']).toMatchObject({ status: 'uncertain', message: 'HTTP 504' });
    await expectHeldOnTheNextRun(first);
  });

  it('quarantines the connection on an auth SendError thrown by another copy of mailroll', async () => {
    const foreign = await foreignErrors();
    const first = new ScriptedProvider(() => ({ deliver: false, error: new foreign.SendError('HTTP 401', 'auth') }));

    const report = await run(first, EMAILS);

    expect(report).toMatchObject({ sent: 0, failed: 0, uncertain: 0, notAttempted: 2 });
    expect((await savedState()).recipients).toEqual({});

    const second = new ScriptedProvider();

    await run(second, EMAILS);
    expect(second.delivered).toEqual([...EMAILS]);
  });

  it.each([
    ['this copy', () => Promise.resolve(new SendCancelledError('aborted mid-request'))],
    ['another copy', async () => new (await foreignErrors()).SendCancelledError('aborted mid-request')],
  ])(
    'records a SendCancelledError raised by the provider (%s) as uncertain, because it does not prove nothing was sent',
    async (_origin, makeError) => {
      const error = await makeError();
      const first = new ScriptedProvider((to) => (to === 'a@x.co' ? { deliver: true, error } : { deliver: true }));

      const report = await run(first, EMAILS);

      expect(report).toMatchObject({ sent: 1, uncertain: 1, notAttempted: 0 });
      await expectHeldOnTheNextRun(first);
    },
  );
});

describe('send outcomes the engine knows for certain', () => {
  it('releases a recipient whose retry wait was cancelled by the run, and sends it once on the next run', async () => {
    const controller = new AbortController();
    const inner = new ScriptedProvider(() => ({
      deliver: false,
      error: new SendError('could not reach the provider (ECONNREFUSED)', 'transient'),
    }));
    const abortingSleeper: Sleeper = {
      sleep: () => {
        controller.abort();

        return Promise.resolve();
      },
    };

    const report = await run(new RetryingEmailProvider(inner, DEFAULT_PACING, abortingSleeper, () => 0), EMAILS, {
      signal: controller.signal,
    });

    expect(report).toMatchObject({ sent: 0, failed: 0, uncertain: 0, notAttempted: 2 });
    expect((await savedState()).recipients).toEqual({});

    const second = new ScriptedProvider();

    await run(second, EMAILS);
    expect(second.delivered).toEqual([...EMAILS]);
    expect(deliveriesTo('a@x.co', inner, second)).toBe(1);
  });

  it('retries a transient SendError thrown by another copy of mailroll and records the send once', async () => {
    const foreign = await foreignErrors();
    const inner = new ScriptedProvider((to, call) =>
      call === 1
        ? { deliver: false, error: new foreign.SendError('could not reach the provider (ECONNREFUSED)', 'transient') }
        : { deliver: true },
    );

    const report = await run(new RetryingEmailProvider(inner, DEFAULT_PACING, instantSleeper, () => 0), EMAILS);

    expect(report).toMatchObject({ sent: 2, failed: 0, uncertain: 0 });
    expect(inner.delivered).toEqual([...EMAILS]);
    expect((await savedState()).recipients['a@x.co']).toMatchObject({ status: 'sent' });
  });
});
