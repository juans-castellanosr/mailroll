import { mkdtempSync, rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncDirectory } from '../../src/fs/sync-directory';

const injected = vi.hoisted(() => ({
  openFailure: undefined as Error | undefined,
  flushFailure: undefined as Error | undefined,
  closeFailure: undefined as Error | undefined,
  opened: [] as FileHandle[],
  flushed: 0,
}));

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
      if (injected.openFailure !== undefined) {
        throw injected.openFailure;
      }

      const handle = await actual.open(...args);
      const closeForReal = handle.close.bind(handle);

      handle.close = async (): Promise<void> => {
        await closeForReal();

        if (injected.closeFailure !== undefined) {
          throw injected.closeFailure;
        }
      };

      injected.opened.push(handle);

      return handle;
    },
  };
});

vi.mock('../../src/fs/flush-to-disk', () => ({
  flushToDisk: (): Promise<void> => {
    if (injected.flushFailure !== undefined) {
      return Promise.reject(injected.flushFailure);
    }

    injected.flushed += 1;

    return Promise.resolve();
  },
}));

const actualPlatform = process.platform;
let dir: string;

function runOn(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function everyOpenedHandleIsClosed(): boolean {
  return injected.opened.every((handle) => handle.fd === -1);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-outlook-directory-sync-'));
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: actualPlatform, configurable: true });
  injected.openFailure = undefined;
  injected.flushFailure = undefined;
  injected.closeFailure = undefined;
  injected.flushed = 0;
  await Promise.all(injected.opened.splice(0).map((handle) => handle.close().catch(() => undefined)));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('syncing the token cache folder', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('flushes the folder and closes its handle on %s', async (platform) => {
    runOn(platform);

    await syncDirectory(dir);

    expect(injected.flushed).toBe(1);
    expect(injected.opened).toHaveLength(1);
    expect(everyOpenedHandleIsClosed()).toBe(true);
  });

  it('skips the flush Windows refuses with EPERM and still closes the handle', async () => {
    runOn('win32');
    injected.flushFailure = codedError('EPERM');

    await expect(syncDirectory(dir)).resolves.toBeUndefined();
    expect(everyOpenedHandleIsClosed()).toBe(true);
  });

  it.each([
    ['linux', 'EPERM'],
    ['linux', 'EIO'],
    ['darwin', 'EPERM'],
    ['win32', 'EIO'],
    ['win32', 'EACCES'],
  ] as const)(
    'propagates a failure to flush the folder on %s with %s unchanged and closes the handle',
    async (platform, code) => {
      runOn(platform);
      injected.flushFailure = codedError(code);

      await expect(syncDirectory(dir)).rejects.toMatchObject({ code, message: `${code}: injected` });
      expect(everyOpenedHandleIsClosed()).toBe(true);
    },
  );

  it('propagates a win32 flush failure that carries no code', async () => {
    runOn('win32');
    const failure = new Error('no code');

    injected.flushFailure = failure;

    await expect(syncDirectory(dir)).rejects.toBe(failure);
    expect(everyOpenedHandleIsClosed()).toBe(true);
  });

  it.each([
    ['linux', 'EPERM'],
    ['win32', 'EPERM'],
    ['win32', 'EACCES'],
  ] as const)('propagates a failure to open the folder on %s with %s unchanged', async (platform, code) => {
    runOn(platform);
    injected.openFailure = codedError(code);

    await expect(syncDirectory(dir)).rejects.toMatchObject({ code, message: `${code}: injected` });
    expect(injected.flushed).toBe(0);
  });

  it('propagates a failure to close the folder after a flush Windows refused', async () => {
    runOn('win32');
    injected.flushFailure = codedError('EPERM');
    injected.closeFailure = codedError('EIO');

    await expect(syncDirectory(dir)).rejects.toBe(injected.closeFailure);
    expect(everyOpenedHandleIsClosed()).toBe(true);
  });
});
