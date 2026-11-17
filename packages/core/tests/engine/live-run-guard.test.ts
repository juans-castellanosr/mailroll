import { describe, expect, it } from 'vitest';
import { MemoryStateStore } from '../../src/adapters/memory-state-store';
import { parseEmailAddress } from '../../src/domain/addressing/email-address';
import type { Recipient } from '../../src/domain/addressing/recipient';
import type { ResolvedTemplate } from '../../src/domain/catalog/template';
import { ConfigError } from '../../src/domain/kernel/errors';
import type { RunMode } from '../../src/domain/run/run-mode';
import type { TemplateState } from '../../src/domain/run/template-state';
import { type PreparedConnectionSender, runTemplate } from '../../src/engine/run-engine';
import type { RunReport } from '../../src/engine/report';
import type { StateStore } from '../../src/ports/state-store';
import { PER_RECIPIENT, ScriptedSender } from '../support/scripted-sender';

function template(statePath = 'list.json'): ResolvedTemplate {
  return {
    id: 't',
    campaignId: 'c',
    ccPolicy: 'optional',
    connectionIds: ['x'],
    dir: '',
    dataDir: '',
    stateDir: '',
    assetsDir: '',
    compiledHtmlPath: '',
    context: {},
    dataFile: 'list.csv',
    dataPath: '',
    statePath,
    pacing: {
      delayBetweenSendsMs: 0,
      maxRetries: 0,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      maxRetryAfterMs: 1,
      maxThrottleWaitMs: 1,
    },
  };
}

class CountingStore extends MemoryStateStore {
  loads = 0;

  override load(t: ResolvedTemplate): Promise<TemplateState> {
    this.loads += 1;

    return super.load(t);
  }
}

interface Hold {
  readonly reached: Promise<void>;
  readonly wait: () => Promise<void>;
  readonly open: () => void;
}

function hold(): Hold {
  let reach: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return {
    reached,
    wait: () => {
      reach();

      return opened;
    },
    open: () => {
      open();
    },
  };
}

async function sender(onSend: () => Promise<void> = () => Promise.resolve()): Promise<PreparedConnectionSender> {
  return new ScriptedSender(async () => {
    await onSend();

    return { outcome: 'accepted' };
  }).prepare(PER_RECIPIENT);
}

function run(
  store: StateStore,
  prepared: PreparedConnectionSender,
  options: { readonly mode?: RunMode; readonly statePath?: string; readonly fail?: boolean } = {},
): Promise<RunReport> {
  return runTemplate<Recipient>({
    template: template(options.statePath),
    source: {
      read: async function* () {
        await Promise.resolve();

        if (options.fail === true) {
          throw new Error('the list cannot be read');
        }

        yield { email: 'a@x.co' };
      },
    },
    validator: {
      validate: (record) => {
        const email = parseEmailAddress(record['email'] ?? '');

        return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
      },
    },
    renderer: { render: () => ({ subject: 's', html: '<p>x</p>' }) },
    ...(options.mode?.kind === 'dry-run'
      ? { providers: new Map([['x', { send: () => Promise.resolve() }]]) }
      : { providers: new Map(), senders: new Map([['x', prepared]]) }),
    connectionIds: ['x'],
    policy: { kind: 'force-all' },
    mode: options.mode ?? { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleeper: { sleep: () => Promise.resolve() },
    now: () => 'NOW',
  });
}

const GUARDED = /is already used by another live run of this state store; nothing was sent/;

describe('one live run per list and state store', () => {
  it('refuses a second concurrent live run on the same store and list before it loads anything', async () => {
    const store = new CountingStore();
    const paused = hold();
    const first = run(store, await sender(paused.wait));

    await paused.reached;

    const second = run(store, await sender());

    await expect(second).rejects.toThrow(ConfigError);
    await expect(second).rejects.toThrow(GUARDED);
    expect(store.loads).toBe(1);

    paused.open();

    expect((await first).sent).toBe(1);
  });

  it('lets live runs on different lists, or on different stores, run at the same time', async () => {
    const store = new CountingStore();
    const other = new CountingStore();
    const paused = hold();
    const first = run(store, await sender(paused.wait));

    await paused.reached;

    const reports = await Promise.all([
      run(store, await sender(), { statePath: 'other-list.json' }),
      run(other, await sender()),
    ]);

    paused.open();

    expect([...reports, await first].map((report) => report.sent)).toEqual([1, 1, 1]);
  });

  it.each<readonly [string, () => RunMode]>([
    ['dry-run', () => ({ kind: 'dry-run' })],
    ['test', testMode],
  ])('does not hold the list during a %s run', async (_label, mode) => {
    const store = new CountingStore();
    const paused = hold();
    const first = run(store, await sender(paused.wait));

    await paused.reached;

    const concurrent = await run(store, await sender(), { mode: mode() });

    paused.open();

    expect(concurrent.total).toBe(1);
    expect((await first).sent).toBe(1);
  });

  it('frees the list when a live run ends, successfully or not', async () => {
    const store = new CountingStore();

    await expect(run(store, await sender(), { fail: true })).rejects.toThrow('the list cannot be read');
    expect((await run(store, await sender())).sent).toBe(1);
    expect((await run(store, await sender())).sent).toBe(1);
  });
});

function testMode(): RunMode {
  const inbox = parseEmailAddress('qa@x.co');

  if (!inbox.ok) {
    throw new Error('test setup: bad test inbox');
  }

  return { kind: 'test', testRecipient: inbox.value };
}
