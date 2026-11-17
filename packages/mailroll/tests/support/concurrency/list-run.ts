import { dirname } from 'node:path';
import {
  type DataSource,
  type Logger,
  type Pacing,
  parseEmailAddress,
  type PreparedConnectionSender,
  type Recipient,
  type ResendPolicy,
  type ResolvedTemplate,
  runTemplate,
  type RunReport,
  type StateStore,
} from '@mailroll/core';

const PACING: Pacing = {
  delayBetweenSendsMs: 0,
  maxRetries: 0,
  baseBackoffMs: 1,
  maxBackoffMs: 1,
  maxRetryAfterMs: 1,
  maxThrottleWaitMs: 1,
};

export interface ListFixture {
  readonly template: ResolvedTemplate;
  readonly emails: readonly string[];
}

export function listAt(statePath: string, emails: readonly string[]): ListFixture {
  const stateDir = dirname(statePath);

  return {
    emails,
    template: {
      id: 'welcome',
      campaignId: 'acme/onboarding',
      ccPolicy: 'optional',
      connectionIds: ['outlook-1'],
      dir: stateDir,
      dataDir: stateDir,
      stateDir,
      assetsDir: stateDir,
      compiledHtmlPath: '',
      context: {},
      dataFile: 'recipients.csv',
      dataPath: '',
      statePath,
      pacing: PACING,
    },
  };
}

class ListSource implements DataSource {
  constructor(private readonly emails: readonly string[]) {}

  async *read(): AsyncIterable<Readonly<Record<string, string>>> {
    for (const email of this.emails) {
      await Promise.resolve();
      yield { email };
    }
  }
}

export interface ListRunOptions {
  readonly list: ListFixture;
  readonly store: StateStore;
  readonly senders: ReadonlyMap<string, PreparedConnectionSender>;
  readonly policy?: ResendPolicy;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export function runList(options: ListRunOptions): Promise<RunReport> {
  return runTemplate<Recipient>({
    template: options.list.template,
    source: new ListSource(options.list.emails),
    validator: {
      validate: (record) => {
        const email = parseEmailAddress(record['email'] ?? '');

        return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
      },
    },
    renderer: { render: () => ({ subject: 'Welcome to Acme', html: '<p>Welcome</p>' }) },
    providers: new Map(),
    senders: options.senders,
    connectionIds: [...options.senders.keys()],
    policy: options.policy ?? { kind: 'pending' },
    mode: { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: options.store,
    logger: options.logger ?? { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleeper: { sleep: () => Promise.resolve() },
    now: () => new Date().toISOString(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export async function runLocked(options: ListRunOptions & { readonly store: StateStore }): Promise<RunReport> {
  const lock = await options.store.lock(options.list.template);

  try {
    return await runList(options);
  } finally {
    await lock.release();
  }
}
