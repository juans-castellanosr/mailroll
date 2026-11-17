import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { syncDirectory } from './sync-directory';

export async function ensureDirectory(dir: string, mode: number): Promise<void> {
  const target = resolve(dir);
  const created = await mkdir(target, { recursive: true, mode });

  if (created === undefined) {
    return;
  }

  for (let level = target; ; level = dirname(level)) {
    await syncDirectory(dirname(level));

    if (level === created || dirname(level) === level) {
      return;
    }
  }
}
