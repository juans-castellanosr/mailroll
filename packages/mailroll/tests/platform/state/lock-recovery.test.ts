import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { type AcquiredLock, acquireFileLock, isLockStillHeld } from '../../../src/platform/state/file-lock';
import { ChildRun, stopAllChildren } from '../../support/concurrency/child-process';
import { interleaver } from '../../support/concurrency/fs-interleave';
import { localPidSpace } from '../../support/local-pid-space';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const { interleaver: hooks } = await import('../../support/concurrency/fs-interleave');

  return {
    ...actual,
    open: hooks.wrap('open', 1, actual.open),
    rename: hooks.wrap('rename', 2, actual.rename),
    link: hooks.wrap('link', 2, actual.link),
    rm: hooks.wrap('rm', 1, actual.rm),
  };
});

interface Contender {
  readonly name: string;
  readonly lock?: AcquiredLock;
  readonly error?: string;
}

const PID_SPACE = await localPidSpace();

let dir: string;
let lockPath: string;
const held: AcquiredLock[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-recovery-'));
  lockPath = join(dir, 'list.json.lock');
  interleaver.reset();
});

afterEach(async () => {
  await Promise.all(held.splice(0).map((lock) => lock.release()));
  await stopAllChildren();
  rmSync(dir, { recursive: true, force: true });
});

async function orphanLock(): Promise<number> {
  const child = ChildRun.start({ kind: 'lock-and-exit', lockPath });
  const pid = await child.pid;

  await child.exited();

  return pid;
}

function contend(name: string): Promise<Contender> {
  return interleaver
    .as(name, () => acquireFileLock(lockPath, 'the list'))
    .then(
      (lock): Contender => {
        held.push(lock);

        return { name, lock };
      },
      (error: unknown): Contender => ({ name, error: error instanceof Error ? error.message : String(error) }),
    );
}

const isLock = (file: string): boolean => file === 'list.json.lock';
const holdersOf = (contenders: readonly Contender[]): string[] =>
  contenders.filter((contender) => contender.lock !== undefined).map((contender) => contender.name);

describe('C8 — recovering a lock left by a dead process', { timeout: 60_000 }, () => {
  it('gives the lock to one recoverer while others wait, with a real orphan and the S1-0 worst-case order', async () => {
    const dead = await orphanLock();
    const bVerifies = interleaver.pauseBefore('B', 'open', 2, isLock);
    const b = contend('B');

    await interleaver.reached(bVerifies);

    const a = await contend('A');

    interleaver.release(bVerifies);

    const recovered = await b;
    const c = await contend('C');

    expect(holdersOf([a, recovered, c])).toEqual(['B']);
    expect(a.error).toMatch(/is being recovered by another run \(process \d+/);
    expect(c.error).toMatch(/is in use by another run/);
    expect(recovered.lock?.recoveredFrom?.pid).toBe(dead);
    expect(recovered.lock === undefined ? false : await isLockStillHeld(recovered.lock)).toBe(true);
    expect(readdirSync(dir)).toEqual(['list.json.lock']);
  });

  it('lets an ordinary acquisition take a lock path the recoverer has just emptied, and the recoverer then backs off', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2 ** 22 + 11, host: hostname(), startedAt: 'T0', token: 'dead', pidSpace: PID_SPACE }),
    );

    const bCreates = interleaver.pauseBefore('B', 'link', 2, (file) =>
      /^list\.json\.lock\.[0-9a-f-]+\.tmp$/.test(file),
    );
    const b = contend('B');

    await interleaver.reached(bCreates);

    const pathWhileEmpty = existsSync(lockPath);
    const c = await contend('C');

    interleaver.release(bCreates);

    const contenders = [await b, c];

    expect(pathWhileEmpty).toBe(false);
    expect(holdersOf(contenders)).toEqual(['C']);
    expect((await b).error).toMatch(/is in use by another run/);
    expect(c.lock === undefined ? false : await isLockStillHeld(c.lock)).toBe(true);
    expect(readdirSync(dir)).toEqual(['list.json.lock']);
  });

  it('never removes, at the end of a recovery, a .recover file that was deleted and recreated by someone else', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2 ** 22 + 11, host: hostname(), startedAt: 'T0', token: 'dead', pidSpace: PID_SPACE }),
    );

    const foreign = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: 'T1',
      token: 'someone-else',
      pidSpace: PID_SPACE,
    });
    const bChecksMarker = interleaver.pauseBefore('B', 'open', 2, (file) => file === 'list.json.lock.recover');
    const b = contend('B');

    await interleaver.reached(bChecksMarker);
    rmSync(`${lockPath}.recover`);
    writeFileSync(`${lockPath}.recover`, foreign);
    interleaver.release(bChecksMarker);

    const outcome = await b;

    expect(holdersOf([outcome])).toEqual(['B']);
    expect(readFileSync(`${lockPath}.recover`, 'utf8')).toBe(foreign);
  });
});

const isMovedAside = (file: string): boolean => file.startsWith('list.json.lock.stale-');
const REMEDY =
  'Make sure that no mailroll run and no lock recovery is active on this list, on every machine that shares this folder, before running again';

function keptCopy(): string {
  const kept = readdirSync(dir).filter(isMovedAside);

  expect(kept).toHaveLength(1);

  return join(dir, kept[0] ?? '');
}

describe('a lock moved aside that turns out to belong to another run', () => {
  it('is never put back by a release, so a third run that used the list meanwhile is not overwritten by the second', async () => {
    const first = await acquireFileLock(lockPath, 'the list');
    const firstRenames = interleaver.pauseBefore('first', 'rename', 1, isLock);
    const firstChecksMoved = interleaver.pauseBefore('first', 'open', 1, isMovedAside);
    const releasing = interleaver
      .as('first', () => first.release())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await interleaver.reached(firstRenames);
    rmSync(lockPath);

    const second = await acquireFileLock(lockPath, 'the list');
    const secondRecord = readFileSync(lockPath, 'utf8');

    interleaver.release(firstRenames);
    await interleaver.reached(firstChecksMoved);

    const third = await acquireFileLock(lockPath, 'the list');
    const thirdHeld = await isLockStillHeld(third);

    await third.release();
    interleaver.release(firstChecksMoved);

    const failure = await releasing;

    expect(await isLockStillHeld(second)).toBe(false);

    const kept = keptCopy();

    expect(thirdHeld).toBe(true);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure instanceof Error ? failure.message : '').toBe(
      `${lockPath} was replaced while this run was releasing its own lock, which only happens if someone deleted it by hand; nothing was deleted: the replacement is kept as ${kept}, and the run whose lock it is will stop at its next check. ${REMEDY}`,
    );
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(kept, 'utf8')).toBe(secondRecord);
  });

  it('is never put back by a recovery, so a third run that used the list meanwhile is not overwritten by the second', async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2 ** 22 + 11, host: hostname(), startedAt: 'T0', token: 'dead', pidSpace: PID_SPACE }),
    );

    const recovererRenames = interleaver.pauseBefore('recoverer', 'rename', 1, isLock);
    const recovererChecksMoved = interleaver.pauseBefore('recoverer', 'open', 1, isMovedAside);
    const recovering = contend('recoverer');

    await interleaver.reached(recovererRenames);
    rmSync(lockPath);

    const second = await acquireFileLock(lockPath, 'the list');
    const secondRecord = readFileSync(lockPath, 'utf8');

    interleaver.release(recovererRenames);
    await interleaver.reached(recovererChecksMoved);

    const third = await acquireFileLock(lockPath, 'the list');
    const thirdHeld = await isLockStillHeld(third);

    await third.release();
    interleaver.release(recovererChecksMoved);

    const outcome = await recovering;

    expect(await isLockStillHeld(second)).toBe(false);

    const kept = keptCopy();

    expect(thirdHeld).toBe(true);
    expect(outcome.lock).toBeUndefined();
    expect(outcome.error).toBe(
      `the lock ${lockPath} was replaced while it was being recovered, which only happens if someone deleted it by hand during the recovery; nothing was deleted: the replacement is kept as ${kept}, and the run whose lock it is will stop at its next check. ${REMEDY}`,
    );
    expect(readdirSync(dir).sort()).toEqual([kept.slice(dir.length + 1)]);
    expect(readFileSync(kept, 'utf8')).toBe(secondRecord);
  });
});
