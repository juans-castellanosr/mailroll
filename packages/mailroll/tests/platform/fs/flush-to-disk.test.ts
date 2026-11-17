import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorCode } from '../../../src/platform/fs/error-code';
import { flushToDisk } from '../../../src/platform/fs/flush-to-disk';

const SOURCE = resolve(import.meta.dirname, '../../../src');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-flush-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(root, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(root, entry.name)]
        : [],
  );
}

describe('flushing a file handle to disk', () => {
  it('flushes a written file', async () => {
    const path = join(dir, 'journal.jsonl');
    const file = await open(path, 'a');

    try {
      await file.write('line\n');
      await flushToDisk(file);
    } finally {
      await file.close();
    }

    expect(readFileSync(path, 'utf8')).toBe('line\n');
  });

  it('flushes a directory, except on win32, where the flush may instead be refused with EPERM', async () => {
    const accepted = process.platform === 'win32' ? ['flushed', 'EPERM'] : ['flushed'];
    const folder = await open(dir, 'r');
    let outcome: string;

    try {
      outcome = await flushToDisk(folder).then(
        () => 'flushed',
        (error: unknown) => errorCode(error) ?? 'no code',
      );
    } finally {
      await folder.close();
    }

    expect(accepted, `directory flush on ${process.platform}`).toContain(outcome);
  });

  it("is the only way the source flushes, because Yarn Plug'n'Play does not implement FileHandle.sync", () => {
    const offenders = sourceFiles(SOURCE).filter((file) => /\.(?:sync|datasync)\(\)/.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
