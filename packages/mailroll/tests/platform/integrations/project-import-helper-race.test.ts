import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureImportHelper,
  IMPORT_HELPER_SOURCE,
  importHelperPath,
} from '../../../src/platform/integrations/project-import-helper';

const race = vi.hoisted(() => ({ winner: undefined as string | undefined, content: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (race.winner !== undefined) {
        await actual.writeFile(race.winner, race.content);

        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {
          code: 'EPERM',
        });
      }

      await actual.rename(from, to);
    },
  };
});

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'mailroll-helper-race-'));
});
afterEach(() => {
  race.winner = undefined;
  rmSync(project, { recursive: true, force: true });
});

describe('the project import helper when another process replaces it at the same moment', () => {
  it('accepts a refused rename when the other process already wrote the right content', async () => {
    const path = importHelperPath(project);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'export const load = () => "stale";\n');
    race.winner = path;
    race.content = IMPORT_HELPER_SOURCE;

    await expect(ensureImportHelper(project)).resolves.toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(IMPORT_HELPER_SOURCE);
    expect(readdirSync(dirname(path))).toEqual(['import.mjs']);
  });

  it('reports a refused rename as a file in use, not as an unwritable folder, when the content is still wrong', async () => {
    const path = importHelperPath(project);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'export const load = () => "stale";\n');
    race.winner = path;
    race.content = 'export const load = () => "still stale";\n';

    await expect(ensureImportHelper(project)).rejects.toThrow(
      /cannot replace the integration import helper at .*; another program may be using it/,
    );
    expect(readdirSync(dirname(path))).toEqual(['import.mjs']);
  });
});
