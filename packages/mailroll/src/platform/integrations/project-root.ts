import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigError } from '@mailroll/core';
import { isEnoent } from '../fs/is-enoent';
import { readOptionalJson } from '../discovery/read-json';

export const HOST_PACKAGE = 'mailroll';
export const INTEGRATION_LIST_FILE = 'mailroll.json';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export interface UserProject {
  readonly dir: string;
  readonly declaredPackages: ReadonlySet<string>;
}

type Manifest =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unusable'; readonly reason: string }
  | { readonly kind: 'read'; readonly declaredPackages: ReadonlySet<string> };

function declaredPackagesOf(manifest: unknown): ReadonlySet<string> {
  const names = new Set<string>();

  if (typeof manifest !== 'object' || manifest === null) {
    return names;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies: unknown = Reflect.get(manifest, field);

    if (typeof dependencies === 'object' && dependencies !== null) {
      for (const name of Object.keys(dependencies)) {
        names.add(name);
      }
    }
  }

  return names;
}

async function manifestIn(dir: string): Promise<Manifest> {
  let manifest: unknown;

  try {
    manifest = await readOptionalJson(join(dir, 'package.json'));
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind: 'unusable', reason: error.message };
    }

    throw error;
  }

  return manifest === undefined ? { kind: 'absent' } : { kind: 'read', declaredPackages: declaredPackagesOf(manifest) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }

    throw new ConfigError(`cannot check ${path}`, { cause: error });
  }
}

function misplacedList(dir: string, manifest: Manifest): ConfigError {
  const detail =
    manifest.kind === 'absent'
      ? `there is no package.json in ${dir}`
      : manifest.kind === 'unusable'
        ? manifest.reason
        : `${join(dir, 'package.json')} does not declare mailroll`;

  return new ConfigError(
    `${join(dir, INTEGRATION_LIST_FILE)} must sit next to the package.json that installs mailroll, but ${detail}; ` +
      'install mailroll in that project (for example "npm install mailroll") or move mailroll.json next to the ' +
      'package.json that declares it',
  );
}

export async function findUserProject(start: string): Promise<UserProject | undefined> {
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = await manifestIn(dir);

    if (manifest.kind === 'read' && manifest.declaredPackages.has(HOST_PACKAGE)) {
      return { dir, declaredPackages: manifest.declaredPackages };
    }

    if (await exists(join(dir, INTEGRATION_LIST_FILE))) {
      throw misplacedList(dir, manifest);
    }

    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}
