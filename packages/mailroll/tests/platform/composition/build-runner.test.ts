import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  type Logger,
  type ResolvedTemplate,
  RunCancelledError,
  type SendSelection,
  SignInRequiredError,
  TemplateRunError,
} from '@mailroll/core';
import { createTestSender, TEST_SENDER_ID, type TestSenderOptions } from '../../support/test-sender';
import { RunInterruptedError, runSelection } from '../../../src/platform/composition/build-runner';
import { parseCcList } from '../../../src/platform/cli/cc';
import { FileStateStore } from '../../../src/platform/state/file-state-store';

const PLUGIN = `
export default {
  prepare: async (template) => {
    if (template.context.broken === 'yes') throw new Error('compiled template not found');
    return {
      listRecipients: async (source) => {
        for await (const _row of source.read()) {}
        return { accepted: ['row@x.co'], rejected: [] };
      },
      run: async (deps) => {
        if (deps.template.context.stopMidway === 'yes') {
          const partial = { total: 2, sent: 1, failed: 0, uncertain: 1, notAttempted: 0, skipped: 0, heldUncertain: 0, results: [] };
          throw new globalThis.__TemplateRunError('stopped', partial, { cause: new Error('disk full') });
        }
        if (deps.template.context.failRun === 'yes') throw new Error('provider exploded');
        globalThis.__runs ??= [];
        globalThis.__runs.push({ templateId: deps.template.id, policy: deps.policy, cc: deps.cc ?? [] });
        const id = deps.connectionIds[0];
        const message = { to: 'row@x.co', subject: 's', html: '<p>x</p>', ...(deps.cc ? { cc: deps.cc } : {}) };
        const bound = deps.senders?.get(id);
        if (bound) {
          const outcome = await bound.sender.send(message, { attemptId: 'a', call: 1 }, { keepSentCopy: false });
          if (outcome.outcome !== 'accepted') throw new Error(outcome.detail);
        } else {
          await deps.providers.get(id).send(message);
        }
        return { total: 1, sent: 1, failed: 0, uncertain: 0, notAttempted: 0, skipped: 0, results: [] };
      },
    };
  },
};
`;

interface RecordedRun {
  readonly templateId: string;
  readonly policy: unknown;
  readonly cc: readonly string[];
}

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const SECRETS = { G_C__OUTLOOK_1__TOKEN: 'secret' };
const ACTIVE: readonly unknown[] = [createTestSender()];
const preparingWith = (beforeReady: TestSenderOptions['beforeReady']): readonly unknown[] => [
  createTestSender(beforeReady === undefined ? {} : { beforeReady }),
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ee-run-'));
  (globalThis as { __runs?: RecordedRun[] }).__runs = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

interface Fixture {
  readonly id: string;
  readonly ccPolicy?: 'forbidden' | 'required' | 'optional';
  readonly cc?: readonly string[];
  readonly csvs?: readonly string[];
  readonly broken?: boolean;
  readonly stopMidway?: boolean;
  readonly failRun?: boolean;
  readonly csvContent?: string;
}

const DEFAULT_FIXTURES: readonly Fixture[] = [{ id: 'with-cc', cc: ['default@org.co'] }, { id: 'no-cc' }];

function scaffold(fixtures: readonly Fixture[] = DEFAULT_FIXTURES): string {
  const base = join(root, 'campaigns', 'g', 'c');

  write(join(base, 'campaign.config.json'), JSON.stringify({ displayName: 'C' }));
  write(
    join(base, 'connections', 'outlook-1.json'),
    JSON.stringify({ id: 'outlook-1', kind: TEST_SENDER_ID, mailbox: 's@org.co' }),
  );
  for (const fixture of fixtures) {
    const dir = join(base, 'templates', fixture.id);

    write(
      join(dir, 'config', 'template.config.json'),
      JSON.stringify({
        ccPolicy: fixture.ccPolicy ?? 'optional',
        connectionIds: ['outlook-1'],
        context: {
          ...(fixture.broken === true ? { broken: 'yes' } : {}),
          ...(fixture.stopMidway === true ? { stopMidway: 'yes' } : {}),
          ...(fixture.failRun === true ? { failRun: 'yes' } : {}),
        },
        ...(fixture.cc !== undefined ? { cc: fixture.cc } : {}),
      }),
    );
    write(join(dir, 'code', 'plugin.ts'), PLUGIN);
    for (const csv of fixture.csvs ?? ['list.csv']) {
      write(join(dir, 'data', csv), fixture.csvContent ?? 'email\nrow@x.co\n');
    }
  }

  return join(root, 'campaigns');
}

function runs(): RecordedRun[] {
  return (globalThis as { __runs?: RecordedRun[] }).__runs ?? [];
}

const baseSelection: SendSelection = {
  campaignId: 'g/c',
  targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc' }],
  connectionIds: ['outlook-1'],
  policy: { kind: 'pending' },
  mode: { kind: 'dry-run' },
};

describe('runSelection', () => {
  it('validates a selection that did not go through buildSelection, before sending anything', async () => {
    const raw = { ...baseSelection, cc: ['not-an-address'] } as unknown as SendSelection;

    await expect(
      runSelection(raw, { integrations: ACTIVE, campaignsRoot: scaffold(), logger: silent }),
    ).rejects.toThrow(/^invalid selection: cc\.0: email is not a valid address/);
    expect(runs()).toEqual([]);
  });

  it('reports a sign-in interrupted with Ctrl-C as a canceled run', async () => {
    const controller = new AbortController();
    const interrupted = preparingWith(() => {
      controller.abort();

      return Promise.reject(new Error('sign-in canceled'));
    });

    await expect(
      runSelection(
        { ...baseSelection, mode: { kind: 'live' } },
        {
          campaignsRoot: scaffold(),
          logger: silent,
          env: SECRETS,
          integrations: interrupted,
          signal: controller.signal,
        },
      ),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(runs()).toEqual([]);
  });

  it('checks the sign-in of every connection before locking or sending anything', async () => {
    const campaignsRoot = scaffold();
    const notSignedIn = preparingWith(() => Promise.reject(new SignInRequiredError('no saved sign-in')));

    await expect(
      runSelection(
        { ...baseSelection, mode: { kind: 'live' } },
        { campaignsRoot, logger: silent, env: SECRETS, integrations: notSignedIn },
      ),
    ).rejects.toBeInstanceOf(SignInRequiredError);
    expect(runs()).toEqual([]);
    expect(existsSync(join(campaignsRoot, 'g', 'c', 'templates', 'with-cc', '.state', 'list.json.lock'))).toBe(false);
  });

  it('hands back the partial report of a list that stopped midway, even when it is the first', async () => {
    (globalThis as { __TemplateRunError?: typeof TemplateRunError }).__TemplateRunError = TemplateRunError;
    const campaignsRoot = scaffold([{ id: 'halting', stopMidway: true }, { id: 'no-cc' }]);

    const error: unknown = await runSelection(
      {
        ...baseSelection,
        targets: [
          { templateId: 'halting', cc: [] },
          { templateId: 'no-cc', cc: [] },
        ],
      },
      { integrations: ACTIVE, campaignsRoot, logger: silent },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunInterruptedError);
    const interrupted = error as RunInterruptedError;

    expect(interrupted.cause).toBeInstanceOf(TemplateRunError);
    expect(interrupted.completed.map((r) => [r.templateId, r.report.sent, r.report.uncertain])).toEqual([
      ['halting', 1, 1],
    ]);
    expect(interrupted.notRun).toEqual([{ templateId: 'no-cc', dataFile: 'list.csv' }]);
    expect(runs()).toEqual([]);
  });

  it('starts nothing when its signal is already aborted', async () => {
    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'no-cc', cc: [] }] },
        { integrations: ACTIVE, campaignsRoot: scaffold(), logger: silent, signal: AbortSignal.abort() },
      ),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(runs()).toEqual([]);
  });

  it('stops between lists on abort and still hands back the lists that finished', async () => {
    const controller = new AbortController();
    const abortOnFirstList: Logger = {
      ...silent,
      info: (event) => {
        if (event === 'cc.resolved') {
          controller.abort();
        }
      },
    };

    const outcome = runSelection(
      { ...baseSelection, targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc', cc: [] }] },
      { integrations: ACTIVE, campaignsRoot: scaffold(), logger: abortOnFirstList, signal: controller.signal },
    );

    const error: unknown = await outcome.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunInterruptedError);
    expect((error as RunInterruptedError).cause).toBeInstanceOf(RunCancelledError);
    expect((error as RunInterruptedError).completed.map((r) => r.templateId)).toEqual(['with-cc']);
    expect(runs().map((r) => r.templateId)).toEqual(['with-cc']);
  });

  it("uses a template's default CC when the run names none, without asking", async () => {
    let asked = 0;

    await runSelection(baseSelection, {
      integrations: ACTIVE,
      campaignsRoot: scaffold(),
      logger: silent,
      resolveCc: () => {
        asked += 1;

        return Promise.resolve(parseCcList('prompted@org.co'));
      },
    });
    expect(runs().map((r) => [r.templateId, r.cc])).toEqual([
      ['with-cc', ['default@org.co']],
      ['no-cc', ['prompted@org.co']],
    ]);
    expect(asked).toBe(1);
  });

  it('lets a target CC override the run CC, which overrides the template default', async () => {
    await runSelection(
      {
        ...baseSelection,
        cc: parseCcList('run@org.co'),
        targets: [{ templateId: 'with-cc', cc: parseCcList('target@org.co') }, { templateId: 'no-cc' }],
      },
      { integrations: ACTIVE, campaignsRoot: scaffold(), logger: silent },
    );
    expect(runs().map((r) => r.cc)).toEqual([['target@org.co'], ['run@org.co']]);
  });

  it('applies a per-target policy over the run policy', async () => {
    const results = await runSelection(
      {
        ...baseSelection,
        targets: [
          { templateId: 'with-cc', policy: { kind: 'subset', recipients: parseCcList('row@x.co') } },
          { templateId: 'no-cc', cc: [] },
        ],
      },
      { integrations: ACTIVE, campaignsRoot: scaffold(), logger: silent },
    );

    expect(runs().map((r) => r.policy)).toEqual([{ kind: 'subset', recipients: ['row@x.co'] }, { kind: 'pending' }]);
    expect(results.map((r) => r.policy)).toEqual(['subset', 'pending']);
  });

  it('writes previews into a fresh folder per template and CSV', async () => {
    const campaignsRoot = scaffold();
    const previewDir = join(root, 'previews');
    const stale = join(previewDir, 'with_cc', 'list', 'stale.html');

    write(stale, 'old');

    const results = await runSelection(
      { ...baseSelection, targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc', cc: [] }] },
      { integrations: ACTIVE, campaignsRoot, logger: silent, previewDir },
    );

    expect(results.map((r) => r.previewDir)).toEqual([
      join(previewDir, 'with_cc', 'list'),
      join(previewDir, 'no_cc', 'list'),
    ]);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(previewDir, 'with_cc', 'list'))).toEqual(['0001-row@x.co.html']);
    expect(readdirSync(join(previewDir, 'no_cc', 'list'))).toEqual(['0001-row@x.co.html']);
  });

  it('stops before the first send when a later target is misconfigured', async () => {
    const campaignsRoot = scaffold();

    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc', dataFile: 'missing.csv' }] },
        { integrations: ACTIVE, campaignsRoot, logger: silent },
      ),
    ).rejects.toThrow(ConfigError);
    expect(runs()).toEqual([]);
  });

  it('refuses a CSV whose name shares a state file with another CSV of the template, even when sent alone', async () => {
    const campaignsRoot = scaffold([{ id: 'with-cc', cc: ['default@org.co'], csvs: ['grupo-1.csv', 'grupo 1.csv'] }]);

    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'with-cc', dataFile: 'grupo-1.csv' }] },
        { integrations: ACTIVE, campaignsRoot, logger: silent },
      ),
    ).rejects.toThrow(/same send-state file/);
    expect(runs()).toEqual([]);
  });

  it('checks every connection secret before the first send of a real run', async () => {
    const campaignsRoot = scaffold();

    await expect(
      runSelection(
        { ...baseSelection, mode: { kind: 'live' } },
        { integrations: ACTIVE, campaignsRoot, logger: silent, env: {} },
      ),
    ).rejects.toThrow(/missing environment secret/);
    expect(runs()).toEqual([]);
  });

  it('refuses a CSV whose name yields an empty state/preview name', async () => {
    const campaignsRoot = scaffold([{ id: 'with-cc', cc: ['default@org.co'], csvs: ['ñ.csv'] }]);

    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'with-cc', dataFile: 'ñ.csv' }] },
        { integrations: ACTIVE, campaignsRoot, logger: silent, previewDir: join(root, 'previews') },
      ),
    ).rejects.toThrow(ConfigError);
  });

  it('rejects a CC on a CC-forbidden template, and a live send without a required CC, before sending', async () => {
    const campaignsRoot = scaffold([
      { id: 'secret', ccPolicy: 'forbidden' },
      { id: 'needs-cc', ccPolicy: 'required' },
    ]);

    await expect(
      runSelection(
        {
          ...baseSelection,
          targets: [{ templateId: 'needs-cc' }, { templateId: 'secret', cc: parseCcList('x@org.co') }],
        },
        { integrations: ACTIVE, campaignsRoot, logger: silent },
      ),
    ).rejects.toThrow(/does not allow CC/);
    await expect(
      runSelection(
        {
          ...baseSelection,
          mode: { kind: 'live' },
          targets: [{ templateId: 'secret' }, { templateId: 'needs-cc', cc: [] }],
        },
        { integrations: ACTIVE, campaignsRoot, logger: silent, env: SECRETS },
      ),
    ).rejects.toThrow(/requires at least one CC/);
    expect(runs()).toEqual([]);
  });

  it('asks the CC resolver once, as required when any live template that asks requires a CC', async () => {
    const campaignsRoot = scaffold([
      { id: 'optional-cc', ccPolicy: 'optional' },
      { id: 'needs-cc', ccPolicy: 'required' },
    ]);
    const asked: boolean[] = [];

    await expect(
      runSelection(
        {
          ...baseSelection,
          mode: { kind: 'live' },
          targets: [{ templateId: 'optional-cc' }, { templateId: 'needs-cc' }],
        },
        {
          integrations: ACTIVE,
          campaignsRoot,
          logger: silent,
          env: SECRETS,
          resolveCc: ({ required }) => {
            asked.push(required);

            return Promise.resolve([]);
          },
        },
      ),
    ).rejects.toThrow(/requires at least one CC/);
    expect(asked).toEqual([true]);
    expect(runs()).toEqual([]);
  });

  it('treats an explicit empty run CC as "no CC", overriding the template default', async () => {
    await runSelection(
      { ...baseSelection, cc: [] },
      { integrations: ACTIVE, campaignsRoot: scaffold(), logger: silent },
    );
    expect(runs().map((r) => r.cc)).toEqual([[], []]);
  });

  it('stops before any send when a later template cannot be prepared or its CSV is malformed', async () => {
    const broken = scaffold([
      { id: 'with-cc', cc: ['default@org.co'] },
      { id: 'no-cc', broken: true },
    ]);

    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc', cc: [] }] },
        { integrations: ACTIVE, campaignsRoot: broken, logger: silent },
      ),
    ).rejects.toThrow(/compiled template not found/);
    expect(runs()).toEqual([]);

    rmSync(join(root, 'campaigns'), { recursive: true, force: true });

    const malformed = scaffold([
      { id: 'with-cc', cc: ['default@org.co'] },
      { id: 'no-cc', csvContent: 'email,name\na@x.co,A,EXTRA\n' },
    ]);

    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc', cc: [] }] },
        { integrations: ACTIVE, campaignsRoot: malformed, logger: silent },
      ),
    ).rejects.toThrow(/parse CSV/);
    expect(runs()).toEqual([]);
  });

  it('refuses a live run on a list another run holds, before sending anything', async () => {
    const campaignsRoot = scaffold();
    const statePath = join(campaignsRoot, 'g', 'c', 'templates', 'no-cc', '.state', 'list.json');

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), startedAt: 'T' }),
    );
    await expect(
      runSelection(
        { ...baseSelection, mode: { kind: 'live' } },
        { campaignsRoot, logger: silent, env: SECRETS, integrations: ACTIVE },
      ),
    ).rejects.toThrow(/in use by another run/);
    expect(runs()).toEqual([]);
    expect(existsSync(join(campaignsRoot, 'g', 'c', 'templates', 'with-cc', '.state', 'list.json.lock'))).toBe(false);
  });

  it('rejects a connection the campaign does not have or the template does not declare', async () => {
    const campaignsRoot = scaffold();

    await expect(
      runSelection(
        { ...baseSelection, connectionIds: ['outlook-1', 'typo'] },
        { integrations: ACTIVE, campaignsRoot, logger: silent },
      ),
    ).rejects.toThrow(/connection "typo" does not exist/);
    expect(runs()).toEqual([]);
  });

  it('refuses a CSV that changed after the operator reviewed it', async () => {
    const campaignsRoot = scaffold();

    await expect(
      runSelection(
        { ...baseSelection, targets: [{ templateId: 'with-cc', dataFingerprint: '0'.repeat(64) }] },
        { integrations: ACTIVE, campaignsRoot, logger: silent },
      ),
    ).rejects.toThrow(/changed after you reviewed it/);
    expect(runs()).toEqual([]);
  });

  it('keeps the results of the lists that ran when a later one stops the run', async () => {
    const campaignsRoot = scaffold();
    const csv = join(campaignsRoot, 'g', 'c', 'templates', 'no-cc', 'data', 'list.csv');
    let first = true;
    const logger: Logger = {
      ...silent,
      info: (event) => {
        if (event === 'cc.resolved' && !first) {
          return;
        }

        if (event === 'cc.resolved') {
          first = false;
          writeFileSync(csv, 'email\nchanged@x.co\n');
        }
      },
    };
    const error = await runSelection(
      { ...baseSelection, targets: [{ templateId: 'with-cc' }, { templateId: 'no-cc', cc: [] }] },
      { integrations: ACTIVE, campaignsRoot, logger },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunInterruptedError);
    expect((error as RunInterruptedError).completed.map((r) => r.templateId)).toEqual(['with-cc']);
    expect((error as Error).message).toMatch(/changed after the run was prepared/);
  });
});

describe('runSelection lock cleanup', () => {
  const live: SendSelection = { ...baseSelection, mode: { kind: 'live' } };
  const twoLists: SendSelection = { ...live, targets: [{ templateId: 'first' }, { templateId: 'second' }] };
  let sends: number;
  let errors: { readonly event: string; readonly error: unknown }[];
  let logger: Logger;

  beforeEach(() => {
    sends = 0;
    errors = [];
    logger = { ...silent, error: (event, fields) => errors.push({ event, error: fields?.['error'] }) };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function counted(): readonly unknown[] {
    return [
      createTestSender({
        onSend: () => {
          sends += 1;
        },
      }),
    ];
  }

  function watchLocks(failRelease: boolean): { readonly acquired: string[]; readonly released: string[] } {
    const acquired: string[] = [];
    const released: string[] = [];
    const realLock = FileStateStore.prototype.lock.bind(new FileStateStore());

    vi.spyOn(FileStateStore.prototype, 'lock').mockImplementation(async (template: ResolvedTemplate) => {
      const lock = await realLock(template);

      acquired.push(template.id);

      return {
        ...lock,
        release: async () => {
          released.push(template.id);

          if (failRelease) {
            throw new Error('EACCES: permission denied');
          }

          await lock.release();
        },
      };
    });

    return { acquired, released };
  }

  function lockFiles(campaignsRoot: string): string[] {
    const templates = join(campaignsRoot, 'g', 'c', 'templates');

    return readdirSync(templates).flatMap((id) => {
      const state = join(templates, id, '.state');

      return existsSync(state) ? readdirSync(state).filter((name) => name.endsWith('.lock')) : [];
    });
  }

  it('releases every lock once after a successful run and returns its results', async () => {
    const campaignsRoot = scaffold([{ id: 'first' }, { id: 'second' }]);
    const locks = watchLocks(false);

    const results = await runSelection(twoLists, { campaignsRoot, logger, env: SECRETS, integrations: counted() });

    expect(results.map((r) => [r.templateId, r.report.sent])).toEqual([
      ['first', 1],
      ['second', 1],
    ]);
    expect(sends).toBe(2);
    expect(locks.released).toEqual(locks.acquired);
    expect(locks.acquired).toEqual(['first', 'second']);
    expect(lockFiles(campaignsRoot)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('releases every lock once when a list stops midway, and keeps the finished lists', async () => {
    (globalThis as { __TemplateRunError?: typeof TemplateRunError }).__TemplateRunError = TemplateRunError;
    const campaignsRoot = scaffold([{ id: 'first' }, { id: 'second', stopMidway: true }]);
    const locks = watchLocks(false);

    const error: unknown = await runSelection(twoLists, {
      campaignsRoot,
      logger,
      env: SECRETS,
      integrations: counted(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunInterruptedError);
    expect((error as RunInterruptedError).completed.map((r) => r.templateId)).toEqual(['first', 'second']);
    expect(sends).toBe(1);
    expect(locks.released).toEqual(['first', 'second']);
    expect(lockFiles(campaignsRoot)).toEqual([]);
  });

  it('releases every lock once and rethrows the original error when the first list fails', async () => {
    const campaignsRoot = scaffold([{ id: 'first', failRun: true }, { id: 'second' }]);
    const locks = watchLocks(false);

    const error: unknown = await runSelection(twoLists, {
      campaignsRoot,
      logger,
      env: SECRETS,
      integrations: counted(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('provider exploded');
    expect(sends).toBe(0);
    expect(locks.released).toEqual(['first', 'second']);
    expect(lockFiles(campaignsRoot)).toEqual([]);
  });

  it('keeps the results of a successful run when releasing a lock fails, and logs the failure', async () => {
    const campaignsRoot = scaffold([{ id: 'first' }, { id: 'second' }]);
    const locks = watchLocks(true);

    const results = await runSelection(twoLists, { campaignsRoot, logger, env: SECRETS, integrations: counted() });

    expect(results.map((r) => r.report.sent)).toEqual([1, 1]);
    expect(sends).toBe(2);
    expect(locks.released).toEqual(['first', 'second']);
    expect(errors).toEqual([{ event: 'state.lock_release_failed', error: 'EACCES: permission denied' }]);
  });

  it('rethrows the run error, not the release error, when both fail', async () => {
    const campaignsRoot = scaffold([{ id: 'first', failRun: true }, { id: 'second' }]);
    const locks = watchLocks(true);

    const error: unknown = await runSelection(twoLists, {
      campaignsRoot,
      logger,
      env: SECRETS,
      integrations: counted(),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe('provider exploded');
    expect(sends).toBe(0);
    expect(locks.released).toEqual(['first', 'second']);
    expect(errors).toEqual([{ event: 'state.lock_release_failed', error: 'EACCES: permission denied' }]);
  });

  it('takes and releases no lock in a dry run', async () => {
    const campaignsRoot = scaffold([{ id: 'first' }, { id: 'second' }]);
    const locks = watchLocks(false);

    await runSelection(
      { ...twoLists, mode: { kind: 'dry-run' } },
      { integrations: ACTIVE, campaignsRoot, logger: silent },
    );

    expect(locks.acquired).toEqual([]);
    expect(locks.released).toEqual([]);
    expect(lockFiles(campaignsRoot)).toEqual([]);
  });
});

describe('runSelection with integrations', () => {
  const live: SendSelection = { ...baseSelection, targets: [{ templateId: 'no-cc' }], mode: { kind: 'live' } };

  it('hands the integration the connection, its secrets, the sign-in mode and its state location', async () => {
    const contexts: {
      connectionId: string;
      interactive: boolean;
      secrets: Readonly<Record<string, string>>;
      stateDirectory: string;
      stateKey: string;
    }[] = [];
    const announced: string[] = [];
    const tokens = join(root, 'tokens');

    await runSelection(live, {
      campaignsRoot: scaffold(),
      logger: silent,
      env: { ...SECRETS, TOKEN_CACHE_PATH: tokens },
      integrations: preparingWith((context) => {
        contexts.push({
          connectionId: context.connectionId,
          interactive: context.interactive,
          secrets: context.secrets,
          stateDirectory: context.stateDirectory,
          stateKey: context.stateKey,
        });
        context.interaction.announce('hello');
      }),
      signIn: 'cached-only',
      onSignInMessage: (message) => announced.push(message),
    });

    expect(contexts).toEqual([
      {
        connectionId: 'outlook-1',
        interactive: false,
        secrets: { TOKEN: 'secret' },
        stateDirectory: join(tokens, 'g_c'),
        stateKey: 'outlook_1',
      },
    ]);
    expect(announced).toEqual(['hello']);
  });

  it('reports a missing secret by its environment variable, before preparing or locking', async () => {
    const campaignsRoot = scaffold();
    let prepared = 0;

    await expect(
      runSelection(live, {
        campaignsRoot,
        logger: silent,
        env: {},
        integrations: preparingWith(() => {
          prepared += 1;
        }),
      }),
    ).rejects.toThrow(new ConfigError('missing environment secret G_C__OUTLOOK_1__TOKEN'));
    expect(prepared).toBe(0);
    expect(runs()).toEqual([]);
  });

  it('refuses a connection whose integration is not active, before doing anything', async () => {
    const campaignsRoot = scaffold();

    writeFileSync(
      join(campaignsRoot, 'g', 'c', 'connections', 'outlook-1.json'),
      JSON.stringify({ id: 'outlook-1', kind: 'acme-mail', mailbox: 's@org.co' }),
    );

    await expect(runSelection(baseSelection, { campaignsRoot, logger: silent, integrations: ACTIVE })).rejects.toThrow(
      'connection "outlook-1" uses the integration "acme-mail", which is not active (active: test-sender)',
    );
    expect(runs()).toEqual([]);
  });

  it('activates nothing by default, so even a dry run refuses a connection whose integration was not given', async () => {
    await expect(runSelection(baseSelection, { campaignsRoot: scaffold(), logger: silent })).rejects.toThrow(
      'connection "outlook-1" uses the integration "test-sender", which is not active (active: none)',
    );
    expect(runs()).toEqual([]);
  });

  it('refuses an integration list that does not pass the public validation', async () => {
    await expect(
      runSelection(live, {
        campaignsRoot: scaffold(),
        logger: silent,
        env: SECRETS,
        integrations: [{ id: TEST_SENDER_ID }],
      }),
    ).rejects.toThrow('integration #1 is not a valid mailroll integration');
  });

  it('closes every prepared integration after the run', async () => {
    let closed = 0;

    await runSelection(live, {
      campaignsRoot: scaffold(),
      logger: silent,
      env: SECRETS,
      integrations: [
        createTestSender({
          onClose: () => {
            closed += 1;
          },
        }),
      ],
    });

    expect(closed).toBe(1);
  });
});

describe('runSelection cleanup of prepared integrations', () => {
  it('closes the prepared integrations when another run holds a list', async () => {
    let closed = 0;
    const campaignsRoot = scaffold();
    const statePath = join(campaignsRoot, 'g', 'c', 'templates', 'no-cc', '.state', 'list.json');

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), startedAt: 'T' }),
    );

    await expect(
      runSelection(
        { ...baseSelection, mode: { kind: 'live' } },
        {
          campaignsRoot,
          logger: silent,
          env: SECRETS,
          integrations: [
            createTestSender({
              onClose: () => {
                closed += 1;
              },
            }),
          ],
        },
      ),
    ).rejects.toThrow(/in use by another run/);
    expect(closed).toBe(1);
  });
});
