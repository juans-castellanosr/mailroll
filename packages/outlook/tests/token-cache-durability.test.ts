import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenCacheContext, type ISerializableTokenCache } from '@azure/msal-node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFileTokenCachePlugin } from '../src/token-cache-plugin';

type Step = 'flush file' | 'flush folder' | 'rename';

const injected = vi.hoisted(() => ({
  steps: [] as Step[],
  renameFailure: undefined as Error | undefined,
  folderFlushFailure: undefined as Error | undefined,
}));

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      if (injected.renameFailure !== undefined) {
        throw injected.renameFailure;
      }

      await actual.rename(...args);
      injected.steps.push('rename');
    },
  };
});

vi.mock('../src/fs/flush-to-disk', () => ({
  flushToDisk: async (handle: FileHandle): Promise<void> => {
    const folder = (await handle.stat()).isDirectory();

    if (folder && injected.folderFlushFailure !== undefined) {
      throw injected.folderFlushFailure;
    }

    injected.steps.push(folder ? 'flush folder' : 'flush file');
  },
}));

class FixedCache implements ISerializableTokenCache {
  constructor(private readonly data: string) {}
  serialize(): string {
    return this.data;
  }

  deserialize(): void {
    throw new Error('not read in these tests');
  }
}

const actualPlatform = process.platform;
let root: string;
let sequence = 0;

function freshCachePath(): { readonly folder: string; readonly path: string } {
  sequence += 1;
  const folder = join(root, `case-${String(sequence)}`);

  return { folder, path: join(folder, 'cache.json') };
}

function save(path: string, data: string): Promise<void> {
  return createFileTokenCachePlugin(path).afterCacheAccess(new TokenCacheContext(new FixedCache(data), true));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-outlook-cache-durability-'));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: actualPlatform, configurable: true });
  injected.steps = [];
  injected.renameFailure = undefined;
  injected.folderFlushFailure = undefined;
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('saving the token cache durably', () => {
  it('flushes the parent of the folder it creates, then the new content, renames it into place, then flushes the folder that holds it', async () => {
    const { path } = freshCachePath();

    await save(path, 'FIRST');

    expect(injected.steps).toEqual(['flush folder', 'flush file', 'rename', 'flush folder']);
    expect(readFileSync(path, 'utf8')).toBe('FIRST');
  });

  it('flushes the parent of every missing folder level before writing the first cache', async () => {
    const { folder } = freshCachePath();
    const path = join(folder, 'campaign', 'cache.json');

    await save(path, 'NESTED');

    expect(injected.steps).toEqual(['flush folder', 'flush folder', 'flush file', 'rename', 'flush folder']);
    expect(readFileSync(path, 'utf8')).toBe('NESTED');
  });

  it('flushes the folder again when it replaces an existing cache', async () => {
    const { path } = freshCachePath();

    await save(path, 'OLD');
    injected.steps = [];
    await save(path, 'NEW');

    expect(injected.steps).toEqual(['flush file', 'rename', 'flush folder']);
    expect(readFileSync(path, 'utf8')).toBe('NEW');
  });

  it('keeps the saved cache when Windows refuses the folder flush with EPERM', async () => {
    const { folder, path } = freshCachePath();

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    injected.folderFlushFailure = codedError('EPERM');

    await expect(save(path, 'SAVED')).resolves.toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('SAVED');
    expect(readdirSync(folder)).toEqual(['cache.json']);
  });

  it.each([
    ['linux', 'EIO'],
    ['linux', 'EPERM'],
    ['win32', 'EIO'],
  ] as const)(
    'reports a failure to flush the folder that holds the saved cache on %s with %s',
    async (platform, code) => {
      const { folder, path } = freshCachePath();

      mkdirSync(folder);
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      injected.folderFlushFailure = codedError(code);

      await expect(save(path, 'UNFLUSHED')).rejects.toMatchObject({ code, message: `${code}: injected` });
      expect(readdirSync(folder)).toEqual(['cache.json']);
    },
  );

  it('writes no cache when the parent of a folder it created cannot be flushed', async () => {
    const { folder, path } = freshCachePath();

    injected.folderFlushFailure = codedError('EIO');

    await expect(save(path, 'UNWRITTEN')).rejects.toMatchObject({ code: 'EIO' });
    expect(injected.steps).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('removes the temporary file and keeps the previous cache when the rename fails', async () => {
    const { folder, path } = freshCachePath();

    await save(path, 'PREVIOUS');
    injected.renameFailure = codedError('EBUSY');

    await expect(save(path, 'LOST')).rejects.toBe(injected.renameFailure);
    expect(readFileSync(path, 'utf8')).toBe('PREVIOUS');
    expect(readdirSync(folder)).toEqual(['cache.json']);
  });
});
