import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const PACKAGE = resolve(import.meta.dirname, '../../..');
const FIXTURES = join(PACKAGE, 'tests', 'fixtures', 'integrations');

export const RUNNING_HOST = 'the running mailroll';

let coreBundle: Promise<string> | undefined;

function bundleCore(): Promise<string> {
  coreBundle ??= build({
    stdin: { contents: "export * from '@mailroll/core';", resolveDir: PACKAGE, loader: 'ts' },
    tsconfig: join(PACKAGE, 'tsconfig.json'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  }).then((result) => result.outputFiles[0]?.text ?? '');

  return coreBundle;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

export interface UserProjectFixture {
  readonly dir: string;
  readonly writeList: (integrations: readonly string[]) => void;
  readonly installFixture: (name: string) => void;
  readonly installPackage: (name: string, files: Readonly<Record<string, string>>, exports?: unknown) => void;
}

export function isRunningHostFixture(hostModule: unknown): boolean {
  return typeof hostModule === 'object' && hostModule !== null && Reflect.get(hostModule, 'host') === RUNNING_HOST;
}

export async function createUserProject(
  dependencies: readonly string[],
  options: { readonly host?: string } = {},
): Promise<UserProjectFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'mailroll-project-'));
  const modules = join(dir, 'node_modules');

  write(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'user-project',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(['mailroll', '@mailroll/core', ...dependencies].map((name) => [name, '*'])),
    }),
  );

  const installPackage = (
    name: string,
    files: Readonly<Record<string, string>>,
    exports: unknown = './index.mjs',
  ): void => {
    write(join(modules, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports }));
    for (const [file, content] of Object.entries(files)) {
      write(join(modules, name, file), content);
    }
  };

  installPackage('@mailroll/core', { 'index.mjs': await bundleCore() });
  installPackage('mailroll', { 'index.mjs': `export const host = ${JSON.stringify(options.host ?? RUNNING_HOST)};\n` });

  return {
    dir,
    writeList: (integrations) => {
      write(join(dir, 'mailroll.json'), JSON.stringify({ integrations }));
    },
    installFixture: (name) => {
      cpSync(join(FIXTURES, name), join(modules, name), { recursive: true });
    },
    installPackage,
  };
}
