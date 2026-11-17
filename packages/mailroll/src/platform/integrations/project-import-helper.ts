import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '@mailroll/core';
import { errorCode } from '../fs/error-code';
import { isEnoent } from '../fs/is-enoent';

export const IMPORT_HELPER_SOURCE = 'export const load = (specifier) => import(specifier);\n';

const UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

export interface ProjectImporter {
  load(specifier: string): Promise<unknown>;
}

export function importHelperPath(projectDir: string): string {
  return join(projectDir, 'node_modules', '.cache', 'mailroll', 'import.mjs');
}

async function currentSource(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }

    throw new ConfigError(`cannot read the integration import helper at ${path}`, { cause: error });
  }
}

function unwritable(dir: string, error: unknown): ConfigError {
  return new ConfigError(
    `cannot create the integration import helper in ${dir}: the folder is not writable. ` +
      'mailroll writes this small file once and then only reads it; make the folder writable for one run, ' +
      'or run mailroll from a writable copy of the project',
    { cause: error },
  );
}

async function writeAtomically(dir: string, path: string): Promise<void> {
  const temporary = join(dir, `.import.mjs.${String(process.pid)}.${randomUUID()}.tmp`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temporary, IMPORT_HELPER_SOURCE, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await rm(temporary, { force: true });

    throw UNWRITABLE_CODES.has(errorCode(error) ?? '')
      ? unwritable(dir, error)
      : new ConfigError(`cannot prepare the integration import helper in ${dir}`, { cause: error });
  }

  try {
    await rename(temporary, path);
  } catch (error) {
    if ((await currentSource(path)) !== IMPORT_HELPER_SOURCE) {
      throw new ConfigError(
        `cannot replace the integration import helper at ${path}; another program may be using it, so close it and run mailroll again`,
        { cause: error },
      );
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ensureImportHelper(projectDir: string): Promise<string> {
  const path = importHelperPath(projectDir);

  if ((await currentSource(path)) !== IMPORT_HELPER_SOURCE) {
    await writeAtomically(dirname(path), path);
  }

  return path;
}

export async function openProjectImporter(projectDir: string): Promise<ProjectImporter> {
  const path = await ensureImportHelper(projectDir);
  const helper: unknown = await import(pathToFileURL(path).href);
  const load: unknown = typeof helper === 'object' && helper !== null ? Reflect.get(helper, 'load') : undefined;

  if (typeof load !== 'function') {
    throw new ConfigError(`the integration import helper at ${path} does not export "load"`);
  }

  return { load: (specifier) => Promise.resolve(Reflect.apply(load, helper, [specifier]) as unknown) };
}
