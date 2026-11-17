import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenCacheContext, type ISerializableTokenCache } from '@azure/msal-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileTokenCachePlugin } from '../src/token-cache-plugin';
import { expectPrivateFile } from './support/private-file';

class FakeCache implements ISerializableTokenCache {
  constructor(public data: string) {}
  serialize(): string {
    return this.data;
  }

  deserialize(cache: string): void {
    this.data = cache;
  }
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-cache-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createFileTokenCachePlugin', () => {
  it('writes the cache 0600 when it changed', async () => {
    const path = join(dir, 'write.json');

    await createFileTokenCachePlugin(path).afterCacheAccess(new TokenCacheContext(new FakeCache('DATA'), true));
    expect(readFileSync(path, 'utf8')).toBe('DATA');
    expectPrivateFile(path);
  });

  it('does not write when unchanged', async () => {
    const path = join(dir, 'unchanged.json');

    await createFileTokenCachePlugin(path).afterCacheAccess(new TokenCacheContext(new FakeCache('X'), false));
    expect(existsSync(path)).toBe(false);
  });

  it('loads an existing cache and tolerates a missing one', async () => {
    const path = join(dir, 'read.json');

    writeFileSync(path, 'STORED', 'utf8');
    const cache = new FakeCache('OLD');

    await createFileTokenCachePlugin(path).beforeCacheAccess(new TokenCacheContext(cache, false));
    expect(cache.data).toBe('STORED');

    const keep = new FakeCache('KEEP');

    await createFileTokenCachePlugin(join(dir, 'absent.json')).beforeCacheAccess(new TokenCacheContext(keep, false));
    expect(keep.data).toBe('KEEP');
  });

  it('treats an unreadable cache as empty with a warning, so a new sign-in is still possible', async () => {
    const path = join(dir, 'corrupt.json');

    writeFileSync(path, '{"Account":{"x":{"home_account_id":"a', 'utf8');
    const warnings: string[] = [];

    class StrictCache extends FakeCache {
      override deserialize(cache: string): void {
        JSON.parse(cache);
        super.deserialize(cache);
      }
    }

    const cache = new StrictCache('EMPTY');

    await createFileTokenCachePlugin(path, (m) => warnings.push(m)).beforeCacheAccess(
      new TokenCacheContext(cache, false),
    );
    expect(cache.data).toBe('EMPTY');
    expect(warnings[0]).toMatch(/unreadable/);
  });

  it('writes atomically, leaving no temporary file behind', async () => {
    const sub = join(dir, 'atomic');
    const path = join(sub, 'cache.json');

    await createFileTokenCachePlugin(path).afterCacheAccess(new TokenCacheContext(new FakeCache('ONE'), true));
    await createFileTokenCachePlugin(path).afterCacheAccess(new TokenCacheContext(new FakeCache('TWO'), true));
    expect(readFileSync(path, 'utf8')).toBe('TWO');
    expect(readdirSync(sub)).toEqual(['cache.json']);
  });
});
