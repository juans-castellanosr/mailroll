import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isEnoent } from './is-enoent';
import { syncDirectory } from './sync-directory';

export async function ensureDirectory(dir: string, mode: number): Promise<void> {
  const target = resolve(dir);
  const missing = await missingLevels(target);

  await mkdir(target, { recursive: true, mode });

  for (const level of missing) {
    await syncDirectory(dirname(level));
  }
}

async function missingLevels(target: string): Promise<string[]> {
  const missing: string[] = [];

  for (let level = target; !(await exists(level)); level = dirname(level)) {
    missing.push(level);

    if (dirname(level) === level) {
      break;
    }
  }

  return missing;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }

    throw error;
  }
}
