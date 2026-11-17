import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPidSpace } from '../../../src/platform/state/process-identity';

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

const PACKAGE = resolve(import.meta.dirname, '../../..');
const MODULE = join(PACKAGE, 'src/platform/state/process-identity.ts');
const REGISTER = join(PACKAGE, 'tests/support/concurrency/native/register.ts');
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const PID_NAMESPACE_PATH = '/proc/self/ns/pid';
const LINUX = process.platform === 'linux';

afterEach(() => {
  faults.readFile.clear();
  faults.stat.clear();
});

const failure = (code: string): Error => Object.assign(new Error(`${code}: injected failure`), { code });

function pidSpaceOfAChildProcess(): unknown {
  const script = `const { readPidSpace } = await import(${JSON.stringify(pathToFileURL(MODULE).href)}); process.stdout.write(JSON.stringify(await readPidSpace('linux', 'host')));`;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      pathToFileURL(REGISTER).href,
      '--input-type=module',
      '--eval',
      script,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  expect(result.stderr).toBe('');

  return JSON.parse(result.stdout);
}

describe.runIf(LINUX)('the process space of a Linux process', () => {
  it('is the boot id of the kernel and the identity of the pid namespace of this process', async () => {
    const namespace = statSync(PID_NAMESPACE_PATH, { bigint: true });
    const bootId = readFileSync(BOOT_ID_PATH, 'utf8').trim();

    expect(await readPidSpace('linux', 'host')).toEqual({
      kind: 'known',
      id: `linux:${bootId}:${String(namespace.dev)}:${String(namespace.ino)}`,
    });
  });

  it('is the same on every reading and in a child process of the same namespace', async () => {
    const first = await readPidSpace('linux', 'host');
    const second = await readPidSpace('linux', 'host');

    expect(first.kind).toBe('known');
    expect(second).toEqual(first);
    expect(pidSpaceOfAChildProcess()).toEqual(first);
  });

  it('does not depend on the host name', async () => {
    expect(await readPidSpace('linux', 'one')).toEqual(await readPidSpace('linux', 'two'));
  });
});

describe('a Linux process space that cannot be read', () => {
  it('is unknown, with the reason, when the boot id cannot be read', async () => {
    faults.readFile.set(BOOT_ID_PATH, () => Promise.reject(failure('EACCES')));

    expect(await readPidSpace('linux', 'host')).toEqual({
      kind: 'unknown',
      reason: `${BOOT_ID_PATH} could not be read (EACCES)`,
    });
  });

  it('is unknown when the boot id file does not hold a boot id', async () => {
    faults.readFile.set(BOOT_ID_PATH, () => Promise.resolve('not-a-boot-id\n'));

    expect(await readPidSpace('linux', 'host')).toEqual({
      kind: 'unknown',
      reason: `${BOOT_ID_PATH} does not hold a boot id`,
    });
  });

  it('is unknown, with the reason, when the pid namespace cannot be read', async () => {
    faults.readFile.set(BOOT_ID_PATH, () => Promise.resolve('11111111-2222-4333-8444-555555555555\n'));
    faults.stat.set(PID_NAMESPACE_PATH, failure('ENOENT'));

    expect(await readPidSpace('linux', 'host')).toEqual({
      kind: 'unknown',
      reason: `${PID_NAMESPACE_PATH} could not be read (ENOENT)`,
    });
  });

  it('names the failure message when the error has no code', async () => {
    faults.readFile.set(BOOT_ID_PATH, () => Promise.reject(new Error('no proc')));

    expect(await readPidSpace('linux', 'host')).toEqual({
      kind: 'unknown',
      reason: `${BOOT_ID_PATH} could not be read (no proc)`,
    });
  });
});

describe('the process space on other platforms', () => {
  it.each(['darwin', 'win32'] as const)(
    'is the platform and the host name on %s, which has one per host',
    async (platform) => {
      expect(await readPidSpace(platform, 'build-01')).toEqual({ kind: 'known', id: `${platform}:build-01` });
    },
  );

  it.each(['freebsd', 'openbsd', 'sunos', 'aix', 'android'] as const)(
    'is unknown on %s, whose process isolation mailroll cannot tell apart',
    async (platform) => {
      expect(await readPidSpace(platform, 'build-01')).toEqual({
        kind: 'unknown',
        reason: `mailroll cannot tell process spaces apart on ${platform}`,
      });
    },
  );
});
