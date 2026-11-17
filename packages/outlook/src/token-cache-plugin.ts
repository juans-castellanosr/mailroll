import { ensureDirectory } from './fs/ensure-directory';
import { flushToDisk } from './fs/flush-to-disk';
import { isEnoent } from './fs/is-enoent';
import { syncDirectory } from './fs/sync-directory';
import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';

export function createFileTokenCachePlugin(
  cachePath: string,
  warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): ICachePlugin {
  return {
    beforeCacheAccess: async (context: TokenCacheContext): Promise<void> => {
      let raw: string;

      try {
        raw = await readFile(cachePath, 'utf8');
      } catch (error) {
        if (isEnoent(error)) {
          return;
        }

        throw error;
      }

      try {
        context.cache.deserialize(raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';

        warn(`Token cache ${cachePath} is unreadable (${detail}); ignoring it — you will be asked to sign in again.`);
      }
    },
    afterCacheAccess: async (context: TokenCacheContext): Promise<void> => {
      if (!context.hasChanged) {
        return;
      }

      const dir = dirname(cachePath);

      await ensureDirectory(dir, 0o700);

      const tmp = `${cachePath}.${randomUUID()}.tmp`;
      const handle = await open(tmp, 'wx', 0o600);

      try {
        await handle.writeFile(context.cache.serialize(), 'utf8');
        await flushToDisk(handle);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw error;
      }

      await handle.close();

      try {
        await rename(tmp, cachePath);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }

      await chmod(cachePath, 0o600);
      await syncDirectory(dir);
    },
  };
}
