import { join } from 'node:path';
import { ConfigError } from '@mailroll/core';
import { errorCode } from '../fs/error-code';
import { integrationListPath, packageNameOf, readIntegrationList } from './integration-list';
import { openProjectImporter, type ProjectImporter } from './project-import-helper';
import { findUserProject, HOST_PACKAGE } from './project-root';

export interface IntegrationSource {
  readonly descriptor: unknown;
  readonly origin: string;
}

export interface ProjectIntegrationOptions {
  readonly cwd: string;
  readonly isRunningHost: (hostModule: unknown) => boolean;
}

type Loaded =
  | { readonly ok: true; readonly source: IntegrationSource }
  | { readonly ok: false; readonly problem: string; readonly error?: unknown };

const NOT_FOUND_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
const TYPESCRIPT_EXTENSION = /Unknown file extension "\.[cm]?ts"/;
const UNPRINTABLE = 'an unprintable value';

function messageOf(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? Reflect.get(error, 'message') : error;
    const text = typeof message === 'string' ? message : String(message);

    return text.split('\n')[0] ?? text;
  } catch {
    return UNPRINTABLE;
  }
}

function missingSpecifier(message: string): string | undefined {
  return /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1];
}

function isTheIntegrationItself(specifier: string, missing: string | undefined): boolean {
  const name = packageNameOf(specifier);

  return missing === name || missing?.startsWith(`${name}/`) === true;
}

function citesItsOwnManifest(specifier: string, message: string): boolean {
  const manifest = join('node_modules', ...packageNameOf(specifier).split('/'), 'package.json');

  return message.includes(manifest) || message.includes(manifest.replaceAll('\\', '/'));
}

export function describeImportFailure(specifier: string, error: unknown): string {
  const code = errorCode(error);
  const message = messageOf(error);

  if (code !== undefined && NOT_FOUND_CODES.has(code) && isTheIntegrationItself(specifier, missingSpecifier(message))) {
    return 'is not installed or cannot be resolved from the project; install it in the project';
  }

  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' && citesItsOwnManifest(specifier, message)) {
    return 'has no importable entry for this specifier; check the name in mailroll.json against the package exports';
  }

  if (
    code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' ||
    (code === 'ERR_UNKNOWN_FILE_EXTENSION' && TYPESCRIPT_EXTENSION.test(message))
  ) {
    return 'loads TypeScript from node_modules (the integration or one of its dependencies); integrations must ship JavaScript';
  }

  return `failed while loading: ${message}`;
}

async function loadOne(importer: ProjectImporter, specifier: string, listFile: string): Promise<Loaded> {
  let module: unknown;

  try {
    module = await importer.load(specifier);
  } catch (error) {
    return { ok: false, problem: `"${specifier}" ${describeImportFailure(specifier, error)}`, error };
  }

  const descriptor: unknown =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined;

  if (descriptor === undefined) {
    return { ok: false, problem: `"${specifier}" has no default export; it is not a mailroll integration` };
  }

  return { ok: true, source: { descriptor, origin: `"${specifier}" (${listFile})` } };
}

async function assertRunningHost(importer: ProjectImporter, options: ProjectIntegrationOptions): Promise<void> {
  let hostModule: unknown;

  try {
    hostModule = await importer.load(HOST_PACKAGE);
  } catch (error) {
    throw new ConfigError(`the project's own copy of mailroll cannot be loaded: ${messageOf(error)}`, {
      cause: error,
    });
  }

  if (!options.isRunningHost(hostModule)) {
    throw new ConfigError(
      'this mailroll is not the copy installed in the project, so the integrations in mailroll.json cannot be ' +
        'activated; run the project\'s copy instead: "npx mailroll", "pnpm exec mailroll" or "yarn mailroll"',
    );
  }
}

export async function loadProjectIntegrations(
  options: ProjectIntegrationOptions,
): Promise<readonly IntegrationSource[]> {
  const project = await findUserProject(options.cwd);

  if (project === undefined) {
    return [];
  }

  const specifiers = (await readIntegrationList(project.dir)) ?? [];

  if (specifiers.length === 0) {
    return [];
  }

  const listFile = integrationListPath(project.dir);
  const undeclared = specifiers.filter((specifier) => !project.declaredPackages.has(packageNameOf(specifier)));

  if (undeclared.length > 0) {
    throw new ConfigError(
      `${listFile} lists ${undeclared.map((s) => `"${s}"`).join(', ')}, which ${undeclared.length === 1 ? 'is' : 'are'} ` +
        `not declared in ${join(project.dir, 'package.json')}; add ${undeclared.length === 1 ? 'it' : 'them'} to the ` +
        'project dependencies (for example "npm install <package>") so mailroll never loads a package by accident',
    );
  }

  const importer = await openProjectImporter(project.dir);

  await assertRunningHost(importer, options);

  const loaded: Loaded[] = [];

  for (const specifier of specifiers) {
    loaded.push(await loadOne(importer, specifier, listFile));
  }

  const failures = loaded.flatMap((entry) => (entry.ok ? [] : [entry]));

  if (failures.length > 0) {
    throw new ConfigError(
      `cannot activate the integrations listed in ${listFile}: ${failures.map((f) => f.problem).join('; ')}`,
      {
        cause: new AggregateError(
          failures.flatMap((failure) => (failure.error === undefined ? [] : [failure.error])),
          'the errors raised while loading the integrations',
        ),
      },
    );
  }

  return loaded.flatMap((entry) => (entry.ok ? [entry.source] : []));
}
