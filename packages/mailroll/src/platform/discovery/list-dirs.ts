import { isEnoent } from '../fs/is-enoent';
import { readdir } from 'node:fs/promises';

export async function listDirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }
}
