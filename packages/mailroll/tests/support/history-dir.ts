import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DirEntry {
  readonly bytes: string;
  readonly mtimeMs: number;
}

export function dirContents(dir: string): Record<string, DirEntry> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => {
        const path = join(dir, name);

        return [name, { bytes: readFileSync(path, 'base64'), mtimeMs: statSync(path).mtimeMs }];
      }),
  );
}

export function fileNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.endsWith('.tmp'))
    .sort();
}
