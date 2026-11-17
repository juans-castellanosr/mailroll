import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { type AcquiredLock, acquireFileLock, isLockStillHeld } from '../../../src/platform/state/file-lock';
import { recordEvidence } from '../../support/concurrency/evidence';
import { explore, scheduler, type Settled } from '../../support/concurrency/fs-scheduler';
import { localPidSpace } from '../../support/local-pid-space';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const { scheduler: hooks } = await import('../../support/concurrency/fs-scheduler');

  return {
    ...actual,
    open: hooks.wrapOpen(actual.open),
    rename: hooks.wrap(actual.rename),
    link: hooks.wrap(actual.link),
    rm: hooks.wrap(actual.rm),
  };
});

vi.mock('../../../src/platform/fs/flush-to-disk', () => ({ flushToDisk: () => Promise.resolve() }));

const DEAD_PID = 2 ** 22 + 11;
const PID_SPACE = await localPidSpace();
const IN_USE = /is in use by another run|is being recovered by another run/;
const DEEP = process.env['MAILROLL_DEEP_EXPLORATION'] === '1';
const TWO_SWITCHES = DEEP ? 3 : 2;
const THREE_SWITCHES = DEEP ? 2 : 1;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-explore-'));
  scheduler.only((path) => path.includes('list.json.lock'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface World {
  readonly dir: string;
  readonly lockPath: string;
  readonly before: Readonly<Record<string, string>>;
}

type Setup = (lockPath: string) => void;

const record = (pid: number, extra: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({ pid, host: hostname(), startedAt: 'T0', pidSpace: PID_SPACE, ...extra });

function files(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exploreAcquisitions(options: {
  readonly label: string;
  readonly actors: readonly string[];
  readonly maxSwitches: number;
  readonly setup: Setup;
  readonly expect: (world: World, settled: readonly Settled<AcquiredLock>[]) => Promise<string | undefined>;
}): Promise<number> {
  let world: World | undefined;
  const result = await explore<AcquiredLock>({
    maxSwitches: options.maxSwitches,
    once: (choose) => {
      const dir = mkdtempSync(join(root, 'run-'));
      const lockPath = join(dir, 'list.json.lock');

      options.setup(lockPath);
      world = { dir, lockPath, before: files(dir) };

      return scheduler.run(
        options.actors.map((name) => ({ name, work: () => acquireFileLock(lockPath, 'the list') })),
        choose,
      );
    },
    check: async (settled) => {
      if (world === undefined) {
        return 'no world';
      }

      const problem = await options.expect(world, settled);

      await Promise.all(settled.flatMap((outcome) => (outcome.ok ? [outcome.value.release()] : [])));
      rmSync(world.dir, { recursive: true, force: true });

      return problem;
    },
  });

  expect(result.failures.slice(0, 3)).toEqual([]);
  recordEvidence(`explored-${options.label}`, { schedules: result.schedules });

  return result.schedules;
}

async function exactlyOneOwner(world: World, settled: readonly Settled<AcquiredLock>[]): Promise<string | undefined> {
  const holders = settled.filter((outcome) => outcome.ok);
  const refused = settled.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));
  const leftovers = readdirSync(world.dir).filter((name) => name !== 'list.json.lock');
  const [holder] = holders;

  if (holders.length !== 1 || !holder?.ok) {
    return `expected exactly one owner, got ${String(holders.length)} (${refused.map(message).join(' | ')})`;
  }

  if (!(await isLockStillHeld(holder.value))) {
    return `${holder.name} believes it holds the lock, but the file on disk is not its own`;
  }

  const unexpected = refused.filter((error) => !(error instanceof ConfigError) || !IN_USE.test(message(error)));

  if (unexpected.length > 0) {
    return `unexpected refusal: ${unexpected.map(message).join(' | ')}`;
  }

  return leftovers.length === 0 ? undefined : `files left behind: ${leftovers.join(', ')}`;
}

function nobodyAndUntouched(pattern: RegExp) {
  return (world: World, settled: readonly Settled<AcquiredLock>[]): Promise<string | undefined> => {
    const holders = settled.filter((outcome) => outcome.ok).map((outcome) => outcome.name);
    const wrong = settled.flatMap((outcome) =>
      outcome.ok || (outcome.error instanceof ConfigError && pattern.test(message(outcome.error)))
        ? []
        : [message(outcome.error)],
    );
    const after = files(world.dir);

    if (holders.length > 0) {
      return Promise.resolve(`nobody may take this lock, but ${holders.join(', ')} did`);
    }

    if (wrong.length > 0) {
      return Promise.resolve(`unexpected refusal: ${wrong.join(' | ')}`);
    }

    return Promise.resolve(
      JSON.stringify(after) === JSON.stringify(world.before) ? undefined : `files changed: ${JSON.stringify(after)}`,
    );
  };
}

describe('every interleaving of lock acquisitions around a lock left by a dead process', { timeout: 600_000 }, () => {
  it('gives the lock to exactly one of two contenders, with an owner token', async () => {
    const schedules = await exploreAcquisitions({
      label: 'orphan-two-with an owner token',
      actors: ['A', 'B'],
      maxSwitches: TWO_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, record(DEAD_PID, { token: 'dead-token' }));
      },
      expect: exactlyOneOwner,
    });

    expect(schedules).toBeGreaterThan(100);
  });

  it('never recovers a lock written by an earlier version, which does not record its process space', async () => {
    await exploreAcquisitions({
      label: 'earlier-version-without-process-space',
      actors: ['A', 'B'],
      maxSwitches: TWO_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0' }));
      },
      expect: nobodyAndUntouched(
        /is in use by another run \(process \d+.*\), and mailroll cannot tell whether that process is still running/,
      ),
    });
  });

  it('never recovers a dead lock taken in another process space', async () => {
    await exploreAcquisitions({
      label: 'orphan-in-another-process-space',
      actors: ['A', 'B'],
      maxSwitches: TWO_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, record(DEAD_PID, { token: 'dead-token', pidSpace: `${PID_SPACE}-elsewhere` }));
      },
      expect: nobodyAndUntouched(/cannot tell whether that process is still running: it was written in process space/),
    });
  });

  it('gives the lock to exactly one of three contenders, whichever of them arrives while the path is empty', async () => {
    const schedules = await exploreAcquisitions({
      label: 'orphan-three',
      actors: ['A', 'B', 'C'],
      maxSwitches: THREE_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, record(DEAD_PID, { token: 'dead-token' }));
      },
      expect: exactlyOneOwner,
    });

    expect(schedules).toBeGreaterThan(100);
  });

  it('never displaces a live owner', async () => {
    await exploreAcquisitions({
      label: 'live-owner',
      actors: ['A', 'B'],
      maxSwitches: TWO_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, record(process.pid, { token: 'live-token' }));
      },
      expect: nobodyAndUntouched(/is in use by another run \(process \d+/),
    });
  });

  it.each([
    ['left by a dead recoverer', record(DEAD_PID, { token: 'dead-recoverer' })],
    ['that cannot be read', '{"pid":'],
    ['written on another machine', JSON.stringify({ pid: DEAD_PID, host: 'elsewhere', startedAt: 'T0', token: 'x' })],
  ])('blocks every recovery while a .recover file %s remains, and changes no file', async (_label, marker) => {
    await exploreAcquisitions({
      label: `orphan-recover-${_label}`,
      actors: ['A', 'B'],
      maxSwitches: TWO_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, record(DEAD_PID, { token: 'dead-token' }));
        writeFileSync(`${lockPath}.recover`, marker);
      },
      expect: nobodyAndUntouched(/cannot be recovered: an earlier recovery of .* did not finish and left .*\.recover/),
    });
  });

  it('waits for a recovery in progress instead of joining it', async () => {
    await exploreAcquisitions({
      label: 'live-recover',
      actors: ['A', 'B'],
      maxSwitches: TWO_SWITCHES,
      setup: (lockPath) => {
        writeFileSync(lockPath, record(DEAD_PID, { token: 'dead-token' }));
        writeFileSync(`${lockPath}.recover`, record(process.pid, { token: 'live-recoverer' }));
      },
      expect: nobodyAndUntouched(/is being recovered by another run \(process \d+/),
    });
  });
});

describe('every interleaving of a release by the owner and two acquisitions', { timeout: 600_000 }, () => {
  it('never lets the release remove a newer lock, and leaves at most one owner', async () => {
    let dir = '';
    let lockPath = '';
    const result = await explore<AcquiredLock | 'released'>({
      maxSwitches: TWO_SWITCHES,
      once: async (choose) => {
        dir = mkdtempSync(join(root, 'run-'));
        lockPath = join(dir, 'list.json.lock');

        const owner = await acquireFileLock(lockPath, 'the list');

        return scheduler.run<AcquiredLock | 'released'>(
          [
            { name: 'owner', work: () => owner.release().then(() => 'released' as const) },
            { name: 'A', work: () => acquireFileLock(lockPath, 'the list') },
            { name: 'B', work: () => acquireFileLock(lockPath, 'the list') },
          ],
          choose,
        );
      },
      check: async (settled) => {
        const holders = settled.flatMap((outcome) =>
          outcome.ok && outcome.value !== 'released' ? [outcome.value] : [],
        );
        const refused = settled.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));
        const [holder] = holders;
        let problem: string | undefined;

        if (holders.length > 1) {
          problem = `${String(holders.length)} owners`;
        } else if (holder !== undefined && !(await isLockStillHeld(holder))) {
          problem = 'the release removed the lock of a newer owner';
        } else if (holder === undefined && existsSync(lockPath)) {
          problem = 'a lock is left on disk with no owner';
        } else if (refused.some((error) => !(error instanceof ConfigError) || !IN_USE.test(message(error)))) {
          problem = `unexpected refusal: ${refused.map(message).join(' | ')}`;
        } else if (readdirSync(dir).some((name) => name !== 'list.json.lock')) {
          problem = `files left behind: ${readdirSync(dir).join(', ')}`;
        }

        await Promise.all(holders.map((lock) => lock.release()));
        rmSync(dir, { recursive: true, force: true });

        return problem;
      },
    });

    recordEvidence('explored-release-and-two-acquisitions', { schedules: result.schedules });

    expect(result.failures.slice(0, 3)).toEqual([]);
    expect(result.schedules).toBeGreaterThan(10);
  });
});

describe('the exploration harness', () => {
  it('leaves no lock behind once every explored acquisition is released', () => {
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
});
