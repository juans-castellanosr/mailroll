import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { acquireFileLock, isLockStillHeld } from '../../../src/platform/state/file-lock';
import { localPidSpace } from '../../support/local-pid-space';

const PID_SPACE = await localPidSpace();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-lock-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const deadLock = (startedAt = 'T0'): string =>
  JSON.stringify({ pid: 2 ** 22 + 11, host: hostname(), startedAt, pidSpace: PID_SPACE });

describe('acquireFileLock', () => {
  it('is exclusive while held and free again after release', async () => {
    const path = join(dir, 'list.lock');
    const first = await acquireFileLock(path, 'the list');

    await expect(acquireFileLock(path, 'the list')).rejects.toThrow(/in use by another run \(process \d+/);
    await first.release();
    await (await acquireFileLock(path, 'the list')).release();
    expect(existsSync(path)).toBe(false);
  });

  it('takes over a lock left by a dead process and says so', async () => {
    const path = join(dir, 'list.lock');

    writeFileSync(path, deadLock());

    const lock = await acquireFileLock(path, 'the list');

    expect(lock.recoveredFrom).toMatchObject({ startedAt: 'T0' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('lets only one of two simultaneous takeovers win', async () => {
    const path = join(dir, 'list.lock');

    writeFileSync(path, deadLock());

    const outcomes = await Promise.allSettled([acquireFileLock(path, 'the list'), acquireFileLock(path, 'the list')]);
    const won = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));

    expect(won).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    await won[0]?.release();
  });

  it('never takes over a live owner, or one on another host it cannot check', async () => {
    const path = join(dir, 'list.lock');

    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 11, host: 'another-host', startedAt: 'T0' }));
    await expect(acquireFileLock(path, 'the list')).rejects.toThrow(/another-host/);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'T1' }));
    await expect(acquireFileLock(path, 'the list')).rejects.toThrow(/since T1/);
  });

  it('does not remove a lock it no longer owns', async () => {
    const path = join(dir, 'list.lock');
    const lock = await acquireFileLock(path, 'the list');

    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'someone-else' }));
    await lock.release();
    expect(existsSync(path)).toBe(true);
  });
});

const DEAD_PID = 2 ** 22 + 11;
const owner = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('the identity of a lock acquisition', () => {
  it('records a random token of its own for every acquisition', async () => {
    const path = join(dir, 'list.lock');
    const first = await acquireFileLock(path, 'the list');
    const firstToken = owner(path)['token'];

    await first.release();

    const second = await acquireFileLock(path, 'the list');
    const secondToken = owner(path)['token'];

    await second.release();

    expect(firstToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondToken).not.toBe(firstToken);
  });

  it('never lets an earlier acquisition release a later one, even with the same pid, host and start time', async () => {
    const path = join(dir, 'list.lock');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const first = await acquireFileLock(path, 'the list');

    rmSync(path);

    const second = await acquireFileLock(path, 'the list');
    const secondOwner = readFileSync(path, 'utf8');

    expect(await isLockStillHeld(first)).toBe(false);
    await first.release();

    expect(readFileSync(path, 'utf8')).toBe(secondOwner);
    expect(await isLockStillHeld(second)).toBe(true);
    await second.release();
    expect(existsSync(path)).toBe(false);
  });

  it('does not take for its own a copy of its lock put back as another file, as a sync tool or a restored backup does', async () => {
    const path = join(dir, 'list.lock');
    const lock = await acquireFileLock(path, 'the list');
    const copy = readFileSync(path, 'utf8');

    renameSync(path, join(dir, 'original-kept-by-the-sync-tool'));
    await (await acquireFileLock(path, 'the list')).release();
    writeFileSync(path, copy);

    expect(await isLockStillHeld(lock)).toBe(false);
    await lock.release();
    expect(readFileSync(path, 'utf8')).toBe(copy);
  });

  it('does not take a lock written without a token for its own, even when every other field matches', async () => {
    const path = join(dir, 'list.lock');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const lock = await acquireFileLock(path, 'the list');
    const { token: _token, ...withoutToken } = owner(path);

    writeFileSync(path, JSON.stringify(withoutToken));

    expect(await isLockStillHeld(lock)).toBe(false);
    await lock.release();
    expect(owner(path)).toEqual(withoutToken);
  });
});

describe('locks without a process space or damaged', () => {
  it('never recovers a lock that does not say which process space it was taken in', async () => {
    const path = join(dir, 'list.lock');
    const unrecorded = JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0' });

    writeFileSync(path, unrecorded);

    await expect(acquireFileLock(path, 'the list')).rejects.toThrow(
      /in use by another run \(process \d+ on .*, since T0\), and mailroll cannot tell whether that process is still running: it does not record the process space/,
    );
    expect(readdirSync(dir)).toEqual(['list.lock']);
    expect(readFileSync(path, 'utf8')).toBe(unrecorded);
  });

  it('never displaces a lock without a process space whose process is alive', async () => {
    const path = join(dir, 'list.lock');
    const live = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'T0' });

    writeFileSync(path, live);

    await expect(acquireFileLock(path, 'the list')).rejects.toThrow(
      /in use by another run \(process \d+ on .*, since T0\)/,
    );
    expect(readFileSync(path, 'utf8')).toBe(live);
  });

  it.each([
    ['an empty file', ''],
    ['a cut-off record', '{"pid":'],
    ['a record without its host', JSON.stringify({ pid: DEAD_PID, startedAt: 'T0' })],
    ['a token that is not text', JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0', token: 7 })],
    ['an empty token', JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0', token: '' })],
    ['a pid that is not a process', JSON.stringify({ pid: 0, host: hostname(), startedAt: 'T0' })],
    ['a negative pid', JSON.stringify({ pid: -1, host: hostname(), startedAt: 'T0' })],
    ['a dead process on another host', JSON.stringify({ pid: DEAD_PID, host: 'elsewhere', startedAt: 'T0' })],
    [
      'a process space that is not text',
      JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0', token: 'x', pidSpace: 7 }),
    ],
    [
      'an empty process space',
      JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0', token: 'x', pidSpace: '' }),
    ],
  ])('never recovers or deletes %s', async (_label, content) => {
    const path = join(dir, 'list.lock');

    writeFileSync(path, content);

    const failure = await acquireFileLock(path, 'the list').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure instanceof Error ? failure.message : '').toMatch(
      /in use by another run .*if no run and no lock recovery is active on this list \(.*\.recover does not exist\), delete/,
    );
    expect(readdirSync(dir)).toEqual(['list.lock']);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });
});
