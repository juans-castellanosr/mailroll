import { execFileSync, execSync, type ExecFileSyncOptions, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'yarn-pnp', 'bun'] as const;

const YARN_BERRY = 'yarn@4.6.0';

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface VerifyArgs {
  readonly packDir: string;
  readonly pm: PackageManager;
}

const requireTool = createRequire(import.meta.url);

function isPackageManager(value: string | undefined): value is PackageManager {
  return PACKAGE_MANAGERS.some((pm) => pm === value);
}

export function parseVerifyArgs(
  argv: readonly string[],
  supported: readonly PackageManager[] = PACKAGE_MANAGERS.filter((pm) => pm !== 'yarn-pnp'),
): VerifyArgs {
  const [packDir, pm] = argv;

  if (packDir === undefined || !isPackageManager(pm) || !supported.includes(pm)) {
    throw new Error(`usage: <script> <pack-directory> <${supported.join('|')}>`);
  }

  return { packDir: resolve(process.env['INIT_CWD'] ?? process.cwd(), packDir), pm };
}

export function readManifest(packageDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageManifest;
}

export function tarballIn(packDir: string, manifest: PackageManifest): string {
  const file = join(packDir, `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`);

  if (!existsSync(file)) {
    throw new Error(`${file} not found: pack ${manifest.name} into ${packDir} first`);
  }

  return file;
}

export function captureNode(args: readonly string[], options: ExecFileSyncOptions): string {
  return execFileSync(process.execPath, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function streamNode(args: readonly string[], options: ExecFileSyncOptions): void {
  execFileSync(process.execPath, args, { ...options, stdio: 'inherit' });
}

const BARE_COMMAND = /^[A-Za-z0-9._-]+$/;

export function windowsCommandLine(command: string, args: readonly string[]): string {
  if (!BARE_COMMAND.test(command)) {
    throw new Error(`refusing to run ${JSON.stringify(command)}: only a bare command name found on PATH is allowed`);
  }

  return [command, ...args.map((part) => `"${part.replaceAll('"', '""')}"`)].join(' ');
}

function packageManagerCommand(pm: PackageManager): { readonly command: string; readonly prefix: readonly string[] } {
  return pm === 'yarn-pnp' ? { command: 'corepack', prefix: [YARN_BERRY] } : { command: pm, prefix: [] };
}

const PACKAGE_MANAGER_ENV = {
  ...process.env,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
};

function streamPackageManager(pm: PackageManager, args: readonly string[], cwd: string): void {
  const { command, prefix } = packageManagerCommand(pm);

  if (process.platform === 'win32') {
    execSync(windowsCommandLine(command, [...prefix, ...args]), { cwd, stdio: 'inherit', env: PACKAGE_MANAGER_ENV });

    return;
  }

  execFileSync(command, [...prefix, ...args], { cwd, stdio: 'inherit', env: PACKAGE_MANAGER_ENV });
}

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ConsumerRunner {
  readonly node: (args: readonly string[]) => CommandResult;
  readonly bin: (name: string, args: readonly string[]) => CommandResult;
}

function collect(result: ReturnType<typeof spawnSync>): CommandResult {
  if (result.error !== undefined) {
    throw result.error;
  }

  return { status: result.status ?? 1, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function runPackageManager(pm: PackageManager, args: readonly string[], cwd: string): CommandResult {
  const { command, prefix } = packageManagerCommand(pm);
  const env = { ...PACKAGE_MANAGER_ENV, NO_COLOR: '1' };

  return process.platform === 'win32'
    ? collect(spawnSync(windowsCommandLine(command, [...prefix, ...args]), { cwd, env, shell: true, encoding: 'utf8' }))
    : collect(spawnSync(command, [...prefix, ...args], { cwd, env, encoding: 'utf8' }));
}

function binCommand(pm: PackageManager, name: string, args: readonly string[]): readonly string[] {
  switch (pm) {
    case 'npm':
      return ['exec', '--no', '--', name, ...args];
    case 'pnpm':
    case 'bun':
      return ['exec', name, ...args];
    case 'yarn':
      return ['--silent', name, ...args];
    case 'yarn-pnp':
      return [name, ...args];
  }
}

export function consumerRunner(project: string, pm: PackageManager): ConsumerRunner {
  const bin = (name: string, args: readonly string[]): CommandResult =>
    runPackageManager(pm, binCommand(pm, name, args), project);

  if (pm === 'yarn-pnp') {
    return { node: (args) => runPackageManager(pm, ['node', ...args], project), bin };
  }

  return {
    node: (args) =>
      collect(
        spawnSync(process.execPath, args, { cwd: project, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' }),
      ),
    bin,
  };
}

export function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`package check failed: ${message}`);
  }

  process.stdout.write(`  ok  ${message}\n`);
}

export function runModule(project: string, file: string, source: string): string {
  const path = join(project, file);

  writeFileSync(path, source);

  return captureNode([path], { cwd: project, env: { ...process.env, NO_COLOR: '1' } });
}

export function compileTypes(project: string, name: string, source: string, compilerOptions: object): void {
  const file = `${name}.ts`;
  const config = `tsconfig.${name}.json`;

  writeFileSync(join(project, file), source);
  writeFileSync(
    join(project, config),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, ...compilerOptions },
      files: [file],
    }),
  );
  streamNode([requireTool.resolve('typescript/bin/tsc'), '-p', join(project, config)], { cwd: project });
}

export function nodeTypeRoots(): readonly string[] {
  return [dirname(dirname(requireTool.resolve('@types/node/package.json')))];
}

export function installedPackages(project: string): readonly string[] {
  const modules = join(project, 'node_modules');

  return readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap((entry) =>
      entry.name.startsWith('@')
        ? readdirSync(join(modules, entry.name)).map((scoped) => `${entry.name}/${scoped}`)
        : [entry.name],
    )
    .sort();
}

function installArgs(pm: PackageManager, project: string): readonly string[] {
  switch (pm) {
    case 'npm':
      return ['install', '--no-audit', '--no-fund', '--ignore-scripts'];
    case 'pnpm':
      return ['install', '--store-dir', join(project, '.pnpm-store'), '--ignore-scripts'];
    case 'yarn':
      return ['install', '--ignore-scripts', '--cache-folder', join(project, '.yarn-cache')];
    case 'yarn-pnp':
      return ['install', '--mode=skip-build'];
    case 'bun':
      return ['install', '--ignore-scripts', '--cache-dir', join(project, '.bun-cache')];
  }
}

function pinningFields(pm: PackageManager, local: Readonly<Record<string, string>>): object {
  switch (pm) {
    case 'npm':
      return { overrides: Object.fromEntries(Object.keys(local).map((name) => [name, `$${name}`])) };
    case 'yarn':
    case 'yarn-pnp':
      return { resolutions: local };
    case 'bun':
      return { overrides: local };
    case 'pnpm':
      return {};
  }
}

function writeConsumerManifest(
  project: string,
  pm: PackageManager,
  tarballs: ReadonlyMap<string, string>,
  registryDependencies: Readonly<Record<string, string>>,
): void {
  const local = Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:${tarball}`]));

  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      private: true,
      type: 'module',
      ...(pm === 'yarn-pnp' ? { packageManager: YARN_BERRY } : {}),
      dependencies: { ...local, ...registryDependencies },
      ...pinningFields(pm, local),
    }),
  );

  if (pm === 'yarn-pnp') {
    writeFileSync(
      join(project, '.yarnrc.yml'),
      [
        'nodeLinker: pnp',
        'pnpFallbackMode: none',
        'enableGlobalCache: false',
        'cacheFolder: ./.yarn-cache',
        'enableTelemetry: false',
      ].join('\n'),
    );
  }

  if (pm === 'pnpm') {
    writeFileSync(
      join(project, 'pnpm-workspace.yaml'),
      [
        'overrides:',
        ...Object.entries(local).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
      ].join('\n'),
    );
  }
}

export function withConsumer(
  pm: PackageManager,
  tarballs: ReadonlyMap<string, string>,
  registryDependencies: Readonly<Record<string, string>>,
  verify: (project: string) => void,
): void {
  const project = mkdtempSync(join(tmpdir(), `mailroll-${pm}-`));

  try {
    process.stdout.write(`Installing ${[...tarballs.keys()].join(' + ')} with ${pm} into ${project}\n`);
    writeConsumerManifest(project, pm, tarballs, registryDependencies);
    streamPackageManager(pm, installArgs(pm, project), project);
    verify(project);
    process.stdout.write(`Package verified with ${pm}.\n`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

export function packDirectory(packageDir: string, destination: string): string {
  streamPackageManager('npm', ['pack', packageDir, '--pack-destination', destination, '--silent'], destination);

  return tarballIn(destination, readManifest(packageDir));
}

export function extractPackageTarball(tarball: string, destination: string): string {
  const result = spawnSync('tar', ['-xzf', '-'], {
    cwd: destination,
    input: readFileSync(tarball),
    encoding: 'utf8',
  });
  const outcome =
    result.signal === null ? `exit code ${String(result.status ?? 'unknown')}` : `signal ${result.signal}`;

  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(`tar could not extract ${tarball} into ${destination} (${outcome}): ${result.stderr.trim()}`, {
      cause: result.error,
    });
  }

  const extracted = join(destination, 'package');

  if (!existsSync(join(extracted, 'package.json'))) {
    throw new Error(`${tarball} does not contain package/package.json, so it is not an npm package tarball`);
  }

  return extracted;
}

const MIN_DEFINITION_LENGTH = 80;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function topLevelDefinitions(file: string): readonly { readonly name: string; readonly body: string }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  return source.statements
    .filter((statement) => ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    .flatMap((statement) => {
      const name = statement.name?.getText(source) ?? '';
      const text = statement.getText(source);
      const body = text.slice(text.indexOf(name) + name.length);

      return body.length >= MIN_DEFINITION_LENGTH ? [{ name, body }] : [];
    });
}

export interface CopiedDefinitions {
  readonly definitions: number;
  readonly copies: readonly string[];
  readonly names: readonly string[];
}

export function copiedDefinitions(sourceDist: string, targetDist: string): CopiedDefinitions {
  const definitions = filesUnder(sourceDist)
    .filter((file) => file.endsWith('.mjs'))
    .flatMap(topLevelDefinitions);
  const texts = filesUnder(targetDist).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  const copied = definitions.filter(({ body }) => texts.some(({ text }) => text.includes(body)));
  const copies = texts.filter(({ text }) => copied.some(({ body }) => text.includes(body))).map(({ file }) => file);

  return { definitions: definitions.length, copies, names: [...new Set(copied.map(({ name }) => name))].sort() };
}
