import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { acquireFileLock, isLockStillHeld } from '../../../src/platform/state/file-lock';
import { localPidSpace } from '../../support/local-pid-space';

interface Fault {
  readonly operation: 'open' | 'rename' | 'link' | 'rm';
  readonly matches: (paths: readonly string[]) => boolean;
  readonly act: () => void;
}

const injected = vi.hoisted(() => ({ faults: [] as Fault[], calls: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const wrap =
    <A extends readonly unknown[], R>(operation: Fault['operation'], original: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const paths = args.filter((arg): arg is string => typeof arg === 'string');
      const index = injected.faults.findIndex((fault) => fault.operation === operation && fault.matches(paths));

      injected.calls.push(`${operation} ${paths.join(' ')}`);

      if (index >= 0) {
        const [fault] = injected.faults.splice(index, 1);

        fault?.act();
      }

      return original(...args);
    };

  return {
    ...actual,
    open: wrap('open', actual.open),
    rename: wrap('rename', actual.rename),
    link: wrap('link', actual.link),
    rm: wrap('rm', actual.rm),
  };
});

const failure = (code: string): never => {
  throw Object.assign(new Error(`${code}: injected failure`), { code });
};

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-lock-faults-'));
  lockPath = join(dir, 'list.json.lock');
  injected.faults.length = 0;
  injected.calls.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STALE = JSON.stringify({
  pid: 2 ** 22 + 11,
  host: hostname(),
  startedAt: 'T0',
  token: 'dead',
  pidSpace: await localPidSpace(),
});
const named =
  (name: string) =>
  (paths: readonly string[]): boolean =>
    paths.some((path) => basename(path) === name);
const theFolder = (paths: readonly string[]): boolean => paths[0] === dir;

async function refusal(work: Promise<unknown>): Promise<Error> {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (!(error instanceof ConfigError)) {
    throw new Error(`expected a ConfigError, got ${String(error)}`);
  }

  return error;
}

describe('a lock file that is published but cannot be flushed', () => {
  it('removes the lock it had just published, reports it, and the next acquisition works', async () => {
    injected.faults.push({ operation: 'open', matches: theFolder, act: () => failure('EIO') });

    const error = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(error.message).toMatch(/could not create .*list\.json\.lock; nothing was left behind/);
    expect(readdirSync(dir)).toEqual([]);

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(await isLockStillHeld(lock)).toBe(true);
    await lock.release();
  });

  it('removes the .recover file it had just published, keeps the stale lock, and the next acquisition recovers it', async () => {
    writeFileSync(lockPath, STALE);
    injected.faults.push({ operation: 'open', matches: theFolder, act: () => failure('EIO') });

    const error = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(error.message).toMatch(/could not create .*list\.json\.lock\.recover; nothing was left behind/);
    expect(readdirSync(dir)).toEqual(['list.json.lock']);
    expect(readFileSync(lockPath, 'utf8')).toBe(STALE);

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(lock.recoveredFrom).toMatchObject({ startedAt: 'T0' });
    await lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('a .recover file that cannot be removed after a recovery', () => {
  it('releases the lock it had just recovered and says what is left to clean up', async () => {
    writeFileSync(lockPath, STALE);
    injected.faults.push({
      operation: 'rename',
      matches: named('list.json.lock.recover'),
      act: () => failure('EACCES'),
    });

    const error = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(error.message).toMatch(
      /could not remove .*\.recover, and the lock it had just recovered was released again\. Make sure that no mailroll run and no lock recovery is active/,
    );
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('releasing a lock', () => {
  it('can be retried after a failed release', async () => {
    const lock = await acquireFileLock(lockPath, 'the list');

    injected.faults.push({ operation: 'rename', matches: named('list.json.lock'), act: () => failure('EBUSY') });

    await expect(lock.release()).rejects.toThrow(/EBUSY/);
    expect(existsSync(lockPath)).toBe(true);
    expect(await isLockStillHeld(lock)).toBe(true);

    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('names the moved copy it could not remove, and leaves nothing else behind', async () => {
    const lock = await acquireFileLock(lockPath, 'the list');

    injected.faults.push({
      operation: 'rm',
      matches: (paths) => paths.some((path) => basename(path).startsWith('list.json.lock.stale-')),
      act: () => failure('EBUSY'),
    });

    const error = await refusal(lock.release());
    const [copy] = readdirSync(dir);

    expect(copy).toMatch(/^list\.json\.lock\.stale-/);
    expect(error.message).toBe(
      `${lockPath} was released, but the copy it was moved to, ${join(dir, copy ?? '')}, could not be removed; mailroll never reads it, and it is safe to delete`,
    );
    expect(await isLockStillHeld(lock)).toBe(false);
  });

  it('never puts back, and keeps aside untouched, a lock that replaced its own between its check and its removal', async () => {
    const lock = await acquireFileLock(lockPath, 'the list');
    const newcomer = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'T7', token: 'newcomer' });
    let replaced = false;
    const replaceOnce = (): void => {
      if (!replaced) {
        replaced = true;
        rmSync(lockPath);
        writeFileSync(lockPath, newcomer);
      }
    };

    injected.faults.push({ operation: 'rename', matches: named('list.json.lock'), act: replaceOnce });
    injected.faults.push({ operation: 'rm', matches: named('list.json.lock'), act: replaceOnce });

    const error = await refusal(lock.release());
    const kept = readdirSync(dir);

    expect(replaced).toBe(true);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^list\.json\.lock\.stale-/);
    expect(error.message).toContain(
      `nothing was deleted: the replacement is kept as ${join(dir, kept[0] ?? '')}, and the run whose lock it is will stop at its next check`,
    );
    expect(readFileSync(join(dir, kept[0] ?? ''), 'utf8')).toBe(newcomer);
  });

  it('removes the lock once when released twice at the same time, and both calls wait for it', async () => {
    const lock = await acquireFileLock(lockPath, 'the list');

    injected.calls.length = 0;
    await Promise.all([lock.release(), lock.release()]);

    expect(existsSync(lockPath)).toBe(false);
    expect(injected.calls.filter((call) => call.startsWith(`rename ${lockPath} `))).toHaveLength(1);
  });
});

describe('a lock replaced by hand while it is being recovered', () => {
  const replacement = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'T5', token: 'by-hand' });
  const replaceByHand = (): void => {
    rmSync(lockPath);
    writeFileSync(lockPath, replacement);
  };

  it('never puts the replacement back, keeps it aside, and removes nothing', async () => {
    writeFileSync(lockPath, STALE);
    injected.faults.push({ operation: 'rename', matches: named('list.json.lock'), act: replaceByHand });

    const error = await refusal(acquireFileLock(lockPath, 'the list'));
    const kept = readdirSync(dir);

    expect(kept).toHaveLength(1);
    expect(error.message).toMatch(
      /was replaced while it was being recovered.*nothing was deleted: the replacement is kept as .*\.stale-.*, and the run whose lock it is will stop at its next check/,
    );
    expect(error.message).toMatch(/no mailroll run and no lock recovery is active/);
    expect(readFileSync(join(dir, kept[0] ?? ''), 'utf8')).toBe(replacement);
  });

  it('never removes a replacement that took the same file number as the lock it replaced', async () => {
    writeFileSync(lockPath, STALE);
    injected.faults.push({
      operation: 'rename',
      matches: named('list.json.lock'),
      act: () => {
        writeFileSync(lockPath, replacement);
      },
    });

    const error = await refusal(acquireFileLock(lockPath, 'the list'));
    const kept = readdirSync(dir);

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^list\.json\.lock\.stale-/);
    expect(error.message).toContain(`the replacement is kept as ${join(dir, kept[0] ?? '')}`);
    expect(readFileSync(join(dir, kept[0] ?? ''), 'utf8')).toBe(replacement);
  });

  it('keeps the moved file under its new name and leaves alone a lock that took the path meanwhile', async () => {
    const newcomer = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'T6', token: 'newcomer' });

    writeFileSync(lockPath, STALE);
    injected.faults.push({ operation: 'rename', matches: named('list.json.lock'), act: replaceByHand });
    injected.faults.push({
      operation: 'open',
      matches: (paths) => paths.some((path) => basename(path).startsWith('list.json.lock.stale-')),
      act: () => {
        writeFileSync(lockPath, newcomer);
      },
    });

    const error = await refusal(acquireFileLock(lockPath, 'the list'));
    const kept = readdirSync(dir).find((name) => name.startsWith('list.json.lock.stale-'));

    expect(kept).toBeDefined();
    expect(error.message).toContain(`the replacement is kept as ${join(dir, kept ?? '')}`);
    expect(readFileSync(join(dir, kept ?? ''), 'utf8')).toBe(replacement);
    expect(readFileSync(lockPath, 'utf8')).toBe(newcomer);
  });
});

describe('the .recover file of another recoverer', () => {
  it('is never removed, even when it was deleted and recreated under the same name', async () => {
    const foreign = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'T1', token: 'someone-else' });

    writeFileSync(lockPath, STALE);
    injected.faults.push({
      operation: 'open',
      matches: (paths) =>
        paths[0] === `${lockPath}.recover` && !readFileSync(lockPath, 'utf8').includes('"token":"dead"'),
      act: () => {
        rmSync(`${lockPath}.recover`);
        writeFileSync(`${lockPath}.recover`, foreign);
      },
    });

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(readFileSync(`${lockPath}.recover`, 'utf8')).toBe(foreign);
    await lock.release();
  });
});
