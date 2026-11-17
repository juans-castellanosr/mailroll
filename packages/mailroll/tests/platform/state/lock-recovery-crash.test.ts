import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { acquireFileLock, isLockStillHeld } from '../../../src/platform/state/file-lock';
import { recordEvidence } from '../../support/concurrency/evidence';
import { localPidSpace } from '../../support/local-pid-space';

const PACKAGE = resolve(import.meta.dirname, '../../..');
const NATIVE = join(PACKAGE, 'tests/support/concurrency/native');
const CHILD_ARGV: readonly string[] = [
  '--experimental-transform-types',
  '--no-warnings',
  '--import',
  pathToFileURL(join(NATIVE, 'register.ts')).href,
  join(NATIVE, 'crash-recovery-child.ts'),
];
const STALE_RECORDS: readonly (readonly [string, string])[] = [
  [
    'a lock with an owner token',
    JSON.stringify({
      pid: 2 ** 22 + 11,
      host: hostname(),
      startedAt: 'T0',
      token: 'dead',
      pidSpace: await localPidSpace(),
    }),
  ],
];
const ALLOWED = /^list\.json\.lock(\.recover)?$|\.tmp$|\.stale-/;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-crash-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function windowsSystemRootNeededByOsLibraries(): Record<string, string> {
  const systemRoot = process.env['SystemRoot'];

  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
}

function recoverAndCrash(lockPath: string, crashAt: number): string {
  const result = spawnSync(process.execPath, CHILD_ARGV, {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...windowsSystemRootNeededByOsLibraries(),
      LOCK_PATH: lockPath,
      LOCK_MODULE: join(PACKAGE, 'src/platform/state/file-lock.ts'),
      MAILROLL_CORE_ENTRY: join(PACKAGE, '../core/src/index.ts'),
      CRASH_AT: String(crashAt),
    },
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  return `${result.signal ?? `exit ${String(result.status)}`}: ${result.stdout.trim()} ${result.stderr.trim()}`.trim();
}

describe('the recovery child command line', () => {
  it('passes the loader hooks to --import as a file: URL, which Node accepts on every platform', () => {
    const importValue = CHILD_ARGV[CHILD_ARGV.indexOf('--import') + 1] ?? '';

    const hooksPath = fileURLToPath(importValue);

    expect(hooksPath).toBe(join(NATIVE, 'register.ts'));
  });
});

describe('a recoverer killed before each of its file operations', { timeout: 300_000 }, () => {
  it.each(STALE_RECORDS)('always leaves a state the next runs handle safely, for %s', async (label, stale) => {
    const observed: Record<string, unknown>[] = [];
    let completed = false;

    for (let crashAt = 1; crashAt <= 60 && !completed; crashAt += 1) {
      const dir = mkdtempSync(join(root, 'case-'));
      const lockPath = join(dir, 'list.json.lock');

      writeFileSync(lockPath, stale);

      const child = recoverAndCrash(lockPath, crashAt);
      const leftBehind = readdirSync(dir).sort();
      const outcomes = await Promise.allSettled([
        acquireFileLock(lockPath, 'the list'),
        acquireFileLock(lockPath, 'the list'),
      ]);
      const holders = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
      const refusals = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected'
          ? [outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason))]
          : [],
      );
      const recoverLeft = leftBehind.includes('list.json.lock.recover');
      const lockLeft = leftBehind.includes('list.json.lock');

      completed = child.startsWith('exit 0: acquired');
      observed.push({
        crashAt,
        child,
        leftBehind,
        holders: holders.length,
        refusals: refusals.map((error) => error.message),
      });

      expect(holders.length, `crash ${String(crashAt)}: ${child}`).toBeLessThanOrEqual(1);
      expect(
        leftBehind.every((name) => ALLOWED.test(name)),
        leftBehind.join(', '),
      ).toBe(true);
      expect(refusals.every((error) => error instanceof ConfigError)).toBe(true);

      if (recoverLeft && lockLeft) {
        expect(holders, `crash ${String(crashAt)}: an unfinished recovery must block recovery`).toEqual([]);
        expect(refusals.map((error) => error.message).join('\n')).toMatch(/cannot be recovered: an earlier recovery/);
        expect(existsSync(`${lockPath}.recover`)).toBe(true);
      } else {
        expect(holders, `crash ${String(crashAt)}: ${child}`).toHaveLength(1);
      }

      for (const holder of holders) {
        expect(await isLockStillHeld(holder)).toBe(true);
        await holder.release();
      }
    }

    recordEvidence(`lock-recovery-crashes-${label}`, observed);

    expect(completed).toBe(true);
    expect(
      observed.some(
        (entry) => Array.isArray(entry['leftBehind']) && entry['leftBehind'].includes('list.json.lock.recover'),
      ),
    ).toBe(true);
  });
});
