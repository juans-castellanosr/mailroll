import { mkdtempSync, rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncDirectory } from '../../../src/platform/state/durable-files';

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

vi.mock('../../../src/platform/fs/flush-to-disk', () => ({
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
  dir = mkdtempSync(join(tmpdir(), 'mailroll-directory-sync-'));
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

describe('syncDirectory', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'flushes the directory and closes its handle on %s',
    async (platform) => {
      runOn(platform);

      await syncDirectory(dir);

      expect(injected.flushed).toBe(1);
      expect(injected.opened).toHaveLength(1);
      expect(everyOpenedHandleIsClosed()).toBe(true);
    },
  );

  it('skips the flush Windows refuses with EPERM and still closes the handle', async () => {
    runOn('win32');
    injected.flushFailure = codedError('EPERM');

    await expect(syncDirectory(dir)).resolves.toBeUndefined();
    expect(injected.opened).toHaveLength(1);
    expect(everyOpenedHandleIsClosed()).toBe(true);
  });

  it.each([
    ['linux', 'EISDIR'],
    ['linux', 'EPERM'],
    ['darwin', 'EPERM'],
    ['win32', 'EISDIR'],
    ['win32', 'EPERM'],
    ['win32', 'EACCES'],
    ['win32', 'ENOENT'],
  ] as const)('propagates a failure to open the directory on %s with %s unchanged', async (platform, code) => {
    runOn(platform);
    injected.openFailure = codedError(code);

    await expect(syncDirectory(dir)).rejects.toMatchObject({ code, message: `${code}: injected` });
    expect(injected.flushed).toBe(0);
  });

  it.each([
    ['linux', 'EPERM'],
    ['linux', 'EIO'],
    ['darwin', 'EPERM'],
    ['win32', 'EISDIR'],
    ['win32', 'EIO'],
    ['win32', 'ENOSPC'],
  ] as const)(
    'propagates a failure to flush the directory on %s with %s unchanged and closes the handle',
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
    ['linux', 'succeeded'],
    ['win32', 'succeeded'],
    ['win32', 'EPERM'],
  ] as const)(
    'propagates an EPERM from closing the directory on %s, whatever the flush outcome (%s)',
    async (platform, flushOutcome) => {
      runOn(platform);
      injected.flushFailure = flushOutcome === 'succeeded' ? undefined : codedError(flushOutcome);
      injected.closeFailure = codedError('EPERM');

      await expect(syncDirectory(dir)).rejects.toBe(injected.closeFailure);
      expect(everyOpenedHandleIsClosed()).toBe(true);
    },
  );
});
