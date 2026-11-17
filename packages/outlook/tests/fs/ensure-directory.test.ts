import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureDirectory } from '../../src/fs/ensure-directory';

const injected = vi.hoisted(() => ({
  synced: [] as string[],
  failure: undefined as Error | undefined,
}));

vi.mock('../../src/fs/sync-directory', () => ({
  syncDirectory: (dir: string): Promise<void> => {
    if (injected.failure !== undefined) {
      return Promise.reject(injected.failure);
    }

    injected.synced.push(dir);

    return Promise.resolve();
  },
}));

let root: string;
let sequence = 0;

function freshRoot(): string {
  sequence += 1;
  const dir = join(root, `case-${String(sequence)}`);

  mkdirSync(dir);

  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-outlook-ensure-directory-'));
});
afterEach(() => {
  injected.synced = [];
  injected.failure = undefined;
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('creating the token cache folder durably', () => {
  it('flushes the parent of every level it creates, innermost first, ending at the folder that already existed', async () => {
    const base = freshRoot();
    const target = join(base, 'tokens', 'campaign', 'connection');

    await ensureDirectory(target, 0o700);

    expect(injected.synced).toEqual([join(base, 'tokens', 'campaign'), join(base, 'tokens'), base]);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'creates every level it adds with the requested mode where the platform has POSIX modes',
    async () => {
      const base = freshRoot();
      const target = join(base, 'tokens', 'campaign');

      await ensureDirectory(target, 0o700);

      expect([join(base, 'tokens'), target].map((level) => statSync(level).mode & 0o777)).toEqual([0o700, 0o700]);
    },
  );

  it('flushes only the parents of the levels that were missing', async () => {
    const base = freshRoot();

    mkdirSync(join(base, 'tokens'));

    await ensureDirectory(join(base, 'tokens', 'campaign', 'connection'), 0o700);

    expect(injected.synced).toEqual([join(base, 'tokens', 'campaign'), join(base, 'tokens')]);
  });

  it('flushes nothing when the folder already exists', async () => {
    const base = freshRoot();

    await ensureDirectory(base, 0o700);

    expect(injected.synced).toEqual([]);
  });

  it('resolves a relative path against the working folder and flushes absolute parents', async () => {
    const base = freshRoot();
    const relativeTarget = relative(process.cwd(), join(base, 'tokens', 'campaign'));

    await ensureDirectory(relativeTarget, 0o700);

    expect(injected.synced).toEqual([join(base, 'tokens'), base]);
  });

  it('resolves a path that passes through another folder, so it flushes only real parents', async () => {
    const base = freshRoot();

    mkdirSync(join(base, 'detour'));

    await ensureDirectory([base, 'detour', '..', 'tokens', 'campaign'].join(sep), 0o700);

    expect(injected.synced).toEqual([join(base, 'tokens'), base]);
    expect(existsSync(join(base, 'tokens', 'campaign'))).toBe(true);
  });

  it('propagates a flush failure and flushes no further level', async () => {
    const base = freshRoot();
    const failure = Object.assign(new Error('EIO: injected'), { code: 'EIO' });

    injected.failure = failure;

    await expect(ensureDirectory(join(base, 'tokens', 'campaign'), 0o700)).rejects.toBe(failure);
    expect(injected.synced).toEqual([]);
  });
});
