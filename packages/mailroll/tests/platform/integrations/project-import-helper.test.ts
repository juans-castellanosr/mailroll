import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureImportHelper,
  IMPORT_HELPER_SOURCE,
  importHelperPath,
  openProjectImporter,
} from '../../../src/platform/integrations/project-import-helper';

const PACKAGE = resolve(import.meta.dirname, '../../..');
const HELPER_MODULE = join(PACKAGE, 'src', 'platform', 'integrations', 'project-import-helper.ts');
const TSX = pathToFileURL(createRequire(join(PACKAGE, 'package.json')).resolve('tsx')).href;
const runFile = promisify(execFile);
const enforcesPosixPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'mailroll-helper-'));
});
afterEach(() => {
  chmodSync(project, 0o755);
  rmSync(project, { recursive: true, force: true });
});

function helperFolderEntries(): string[] {
  return readdirSync(dirname(importHelperPath(project)));
}

describe('the project import helper', () => {
  it('is a fixed file inside the project node_modules/.cache, and is reused while unchanged', async () => {
    const path = await ensureImportHelper(project);

    expect(path).toBe(join(project, 'node_modules', '.cache', 'mailroll', 'import.mjs'));
    expect(readFileSync(path, 'utf8')).toBe(IMPORT_HELPER_SOURCE);

    const written = statSync(path).mtimeMs;

    await ensureImportHelper(project);

    expect(statSync(path).mtimeMs).toBe(written);
  });

  it('replaces a helper whose content was changed', async () => {
    const path = importHelperPath(project);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'export const load = () => "tampered";\n');

    await ensureImportHelper(project);

    expect(readFileSync(path, 'utf8')).toBe(IMPORT_HELPER_SOURCE);
  });

  it('imports through the helper, so specifiers resolve from the project', async () => {
    mkdirSync(join(project, 'node_modules', 'only-here'), { recursive: true });
    writeFileSync(
      join(project, 'node_modules', 'only-here', 'package.json'),
      JSON.stringify({ name: 'only-here', type: 'module', exports: './index.mjs' }),
    );
    writeFileSync(join(project, 'node_modules', 'only-here', 'index.mjs'), 'export default "from the project";\n');

    const importer = await openProjectImporter(project);

    await expect(importer.load('only-here')).resolves.toMatchObject({ default: 'from the project' });
  });

  it('survives many simultaneous creations in one process, leaving one complete file and no temporaries', async () => {
    await Promise.all(Array.from({ length: 20 }, () => ensureImportHelper(project)));

    expect(readFileSync(importHelperPath(project), 'utf8')).toBe(IMPORT_HELPER_SOURCE);
    expect(helperFolderEntries()).toEqual(['import.mjs']);
  });

  it('survives several processes creating it at the same time', async () => {
    const script = join(project, 'create-helper.mts');

    writeFileSync(
      script,
      `import { ensureImportHelper } from ${JSON.stringify(pathToFileURL(HELPER_MODULE).href)};\n` +
        `await ensureImportHelper(${JSON.stringify(project)});\n`,
    );

    await Promise.all(
      Array.from({ length: 6 }, () =>
        runFile(process.execPath, ['--import', TSX, script], {
          env: { ...process.env, TSX_TSCONFIG_PATH: join(PACKAGE, 'tsconfig.json') },
        }),
      ),
    );

    expect(readFileSync(importHelperPath(project), 'utf8')).toBe(IMPORT_HELPER_SOURCE);
    expect(helperFolderEntries()).toEqual(['import.mjs']);
  }, 60_000);

  it.runIf(enforcesPosixPermissions)('works in a read-only project once the helper exists', async () => {
    await ensureImportHelper(project);
    chmodSync(dirname(importHelperPath(project)), 0o555);

    try {
      await expect(ensureImportHelper(project)).resolves.toBe(importHelperPath(project));
    } finally {
      chmodSync(dirname(importHelperPath(project)), 0o755);
    }
  });

  it.runIf(enforcesPosixPermissions)('explains how to fix a project where the helper cannot be created', async () => {
    chmodSync(project, 0o555);

    await expect(ensureImportHelper(project)).rejects.toThrow(
      `cannot create the integration import helper in ${dirname(importHelperPath(project))}: the folder is not writable`,
    );
  });
});
