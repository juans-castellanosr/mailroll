import { isEnoent } from '../fs/is-enoent';
import { readdir } from 'node:fs/promises';

export async function listDataFiles(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(dataDir)).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }
}
