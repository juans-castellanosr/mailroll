import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { acquireFileLock } from '../../../src/platform/state/file-lock';
import type * as FsPromises from 'node:fs/promises';
import type * as ProcessIdentity from '../../../src/platform/state/process-identity';
import { readPidSpace } from '../../../src/platform/state/process-identity';
import { localPidSpace } from '../../support/local-pid-space';

const faults = vi.hoisted(() => ({
  readFile: new Map<string, () => Promise<string>>(),
  stat: new Map<string, Error>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> => {
      const fault = typeof args[0] === 'string' ? faults.readFile.get(args[0]) : undefined;

      return fault === undefined ? actual.readFile(...args) : fault();
    },
    stat: (...args: Parameters<typeof actual.stat>): ReturnType<typeof actual.stat> => {
      const fault = typeof args[0] === 'string' ? faults.stat.get(args[0]) : undefined;

      return fault === undefined ? actual.stat(...args) : Promise.reject(fault);
    },
  };
});

vi.mock('../../../src/platform/state/process-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessIdentity>();

  return { ...actual, readPidSpace: vi.fn(actual.readPidSpace) };
});

const DEAD_PID = 2 ** 22 + 11;
const PID_SPACE = await localPidSpace();
const FOREIGN_SPACE = 'sunos:another-machine';
const OTHER_BOOT_ID = '00000000-0000-4000-8000-000000000000';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const PID_NAMESPACE_PATH = '/proc/self/ns/pid';
const LINUX = process.platform === 'linux';
const [, LOCAL_BOOT_ID = '', LOCAL_NS_DEV = '', LOCAL_NS_INO = ''] = PID_SPACE.split(':');

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-pid-space-'));
  lockPath = join(dir, 'list.json.lock');
});

afterEach(() => {
  vi.mocked(readPidSpace).mockReset();
  faults.readFile.clear();
  faults.stat.clear();
  rmSync(dir, { recursive: true, force: true });
});

const lockRecord = (fields: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: 'T0', token: 'dead', ...fields });

async function refusal(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (!(error instanceof ConfigError)) {
    throw new Error(`expected a ConfigError, got ${String(error)}`);
  }

  return error.message;
}

const failure = (code: string): Error => Object.assign(new Error(`${code}: injected failure`), { code });

describe('a lock left by a process that is no longer running', () => {
  it('is recovered when it was taken in the same process space', async () => {
    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(lock.recoveredFrom).toEqual({ pid: DEAD_PID, host: hostname(), startedAt: 'T0' });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid, pidSpace: PID_SPACE });
    await lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is refused, untouched, when it was taken in another process space with the same host name', async () => {
    const foreign = lockRecord({ pidSpace: FOREIGN_SPACE });

    writeFileSync(lockPath, foreign);

    const message = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(message).toContain(
      `the list is in use by another run (process ${String(DEAD_PID)} on ${hostname()}, since T0), and mailroll cannot tell whether that process is still running: it was written in process space ${FOREIGN_SPACE}, and this run is in ${PID_SPACE}: by another machine, container or operating system with the same host name`,
    );
    expect(message).toContain(
      `on every machine and container that shares this folder under the host name ${hostname()}, and that no lock recovery is active on this list (${lockPath}.recover does not exist), delete ${lockPath}`,
    );
    expect(readdirSync(dir)).toEqual(['list.json.lock']);
    expect(readFileSync(lockPath, 'utf8')).toBe(foreign);
  });

  it('is refused when its process id is alive here but it was taken in another process space', async () => {
    writeFileSync(lockPath, lockRecord({ pid: process.pid, pidSpace: FOREIGN_SPACE }));

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toMatch(
      /cannot tell whether that process is still running: it was written in process space/,
    );
  });

  it.each(['darwin', 'win32'] as const)(
    'is recovered on %s whenever the host name matches, because one host name is one process space there',
    async (platform) => {
      const space = `${platform}:${hostname()}`;

      vi.mocked(readPidSpace).mockResolvedValue({ kind: 'known', id: space });
      writeFileSync(lockPath, lockRecord({ pidSpace: space }));

      const lock = await acquireFileLock(lockPath, 'the list');

      expect(lock.recoveredFrom).toEqual({ pid: DEAD_PID, host: hostname(), startedAt: 'T0' });
      await lock.release();
    },
  );

  it('is refused when it does not record its process space', async () => {
    const legacy = lockRecord({});

    writeFileSync(lockPath, legacy);

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toMatch(
      /cannot tell whether that process is still running: it does not record the process space it was written in, as is the case for locks written by mailroll 0\.1/,
    );
    expect(readFileSync(lockPath, 'utf8')).toBe(legacy);
  });

  it('is refused when this run cannot read its own process space, and the lock it takes records none', async () => {
    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));
    vi.mocked(readPidSpace).mockResolvedValue({
      kind: 'unknown',
      reason: '/proc/self/ns/pid could not be read (EACCES)',
    });

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toContain(
      'cannot tell whether that process is still running: this run cannot read its own process space, because /proc/self/ns/pid could not be read (EACCES)',
    );

    rmSync(lockPath);

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).not.toHaveProperty('pidSpace');
    await lock.release();
  });

  it('is left to the owner check alone when it was taken on another host', async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, host: 'elsewhere', startedAt: 'T0', pidSpace: PID_SPACE }));

    const message = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(message).toMatch(/is in use by another run \(process \d+ on elsewhere, since T0\)\. Wait for it to finish;/);
    expect(message).not.toContain('cannot tell');
  });
});

describe.runIf(LINUX)('a lock left by a dead process on Linux, with the same host name', () => {
  it('is refused, with both boots, when it was taken during another boot in the same PID namespace', async () => {
    const otherBoot = `linux:${OTHER_BOOT_ID}:${LOCAL_NS_DEV}:${LOCAL_NS_INO}`;
    const stale = lockRecord({ pidSpace: otherBoot });

    writeFileSync(lockPath, stale);

    const message = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(message).toBe(
      `the list is in use by another run (process ${String(DEAD_PID)} on ${hostname()}, since T0), and mailroll cannot tell whether that process is still running: it was written during another boot of a Linux kernel (boot id ${OTHER_BOOT_ID}, PID namespace ${LOCAL_NS_DEV}:${LOCAL_NS_INO}; this run: boot id ${LOCAL_BOOT_ID}, PID namespace ${LOCAL_NS_DEV}:${LOCAL_NS_INO}): this machine has restarted since, or it was written by another machine with the same host name. Wait for it to finish. Only once you are sure that it has ended, on every machine and container that shares this folder under the host name ${hostname()}, and that no lock recovery is active on this list (${lockPath}.recover does not exist), delete ${lockPath}`,
    );
    expect(readFileSync(lockPath, 'utf8')).toBe(stale);
  });

  it('is refused, with both namespaces, when it was taken in another PID namespace of the same boot', async () => {
    writeFileSync(lockPath, lockRecord({ pidSpace: `linux:${LOCAL_BOOT_ID}:${LOCAL_NS_DEV}:1` }));

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toContain(
      `it was written in another PID namespace of this machine (PID namespace ${LOCAL_NS_DEV}:1; this run: PID namespace ${LOCAL_NS_DEV}:${LOCAL_NS_INO}, both in boot ${LOCAL_BOOT_ID}): by another container, by a container that has been restarted since, or by the host outside the containers`,
    );
  });

  it.each([
    ['the boot id cannot be read', () => faults.readFile.set(BOOT_ID_PATH, () => Promise.reject(failure('EACCES')))],
    ['the boot id is not one', () => faults.readFile.set(BOOT_ID_PATH, () => Promise.resolve('garbage\n'))],
    ['the PID namespace cannot be read', () => faults.stat.set(PID_NAMESPACE_PATH, failure('ENOENT'))],
  ])('is never recovered when %s, and the lock this run then takes records no process space', async (_label, fail) => {
    const stale = lockRecord({ pidSpace: PID_SPACE });

    writeFileSync(lockPath, stale);
    fail();

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toMatch(
      /cannot tell whether that process is still running: this run cannot read its own process space, because \/proc\//,
    );
    expect(readFileSync(lockPath, 'utf8')).toBe(stale);

    rmSync(lockPath);

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).not.toHaveProperty('pidSpace');
    await lock.release();
  });

  it('normalizes the whitespace and case around the boot id', async () => {
    faults.readFile.set(BOOT_ID_PATH, () => Promise.resolve(`  ${LOCAL_BOOT_ID.toUpperCase()}\n\n`));
    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));

    const lock = await acquireFileLock(lockPath, 'the list');

    expect(lock.recoveredFrom?.pid).toBe(DEAD_PID);
    await lock.release();
  });
});

describe('a .recover file of a recovery that mailroll cannot check', () => {
  it('blocks the recovery and says that its owner may still be running in another process space', async () => {
    const marker = `${lockPath}.recover`;
    const foreignRecoverer = lockRecord({ pid: DEAD_PID + 1, startedAt: 'T1', pidSpace: FOREIGN_SPACE });

    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));
    writeFileSync(marker, foreignRecoverer);

    const message = await refusal(acquireFileLock(lockPath, 'the list'));

    expect(message).toContain(
      `the list cannot be recovered: ${marker} shows that process ${String(DEAD_PID + 1)} on ${hostname()}, since T1, is recovering ${lockPath} or stopped while doing so, and mailroll cannot tell whether that process is still running: it was written in process space ${FOREIGN_SPACE}, and this run is in ${PID_SPACE}`,
    );
    expect(message).toContain(
      `If it is still running, try again when it finishes. Otherwise make sure that no mailroll run and no lock recovery is active on this list, on every machine and container that shares this folder under the host name ${hostname()}; then delete ${marker}, and delete ${lockPath} too if the process that holds it is not running`,
    );
    expect(readFileSync(marker, 'utf8')).toBe(foreignRecoverer);
    expect(readdirSync(dir).sort()).toEqual(['list.json.lock', 'list.json.lock.recover']);
  });

  it('blocks the recovery the same way when the .recover file does not record its process space', async () => {
    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));
    writeFileSync(`${lockPath}.recover`, lockRecord({ startedAt: 'T1' }));

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toMatch(
      /cannot be recovered: .*\.recover shows that process \d+ .* cannot tell whether that process is still running: it does not record the process space/,
    );
    expect(existsSync(`${lockPath}.recover`)).toBe(true);
  });

  it('still reports a recovery in progress in the same process space as in progress', async () => {
    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));
    writeFileSync(`${lockPath}.recover`, lockRecord({ pid: process.pid, startedAt: 'T1', pidSpace: PID_SPACE }));

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toMatch(
      /is being recovered by another run \(process \d+ on .*, since T1\); try again when it finishes/,
    );
  });

  it('still reports an unfinished recovery in the same process space as unfinished', async () => {
    writeFileSync(lockPath, lockRecord({ pidSpace: PID_SPACE }));
    writeFileSync(`${lockPath}.recover`, lockRecord({ startedAt: 'T1', pidSpace: PID_SPACE }));

    expect(await refusal(acquireFileLock(lockPath, 'the list'))).toMatch(
      /cannot be recovered: an earlier recovery of .* did not finish and left .*\.recover/,
    );
  });
});
