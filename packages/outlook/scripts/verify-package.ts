import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  compileTypes,
  consumerRunner,
  copiedDefinitions,
  nodeTypeRoots,
  type PackageManifest,
  packDirectory,
  parseVerifyArgs,
  readManifest,
  tarballIn,
  windowsCommandLine,
  withConsumer,
} from '../../../scripts/consumer-project.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readManifest(PACKAGE);
const { packDir, pm } = parseVerifyArgs(process.argv.slice(2), ['npm', 'pnpm', 'yarn', 'yarn-pnp', 'bun']);
const requireFromPackage = createRequire(join(PACKAGE, 'package.json'));
const core = readManifest(dirname(requireFromPackage.resolve('@mailroll/core/package.json')));
const mailroll = readManifest(dirname(requireFromPackage.resolve('mailroll/package.json')));
const plugAndPlay = pm === 'yarn-pnp';

const RUNTIME_EXPORTS = [
  'GraphClient',
  'OUTLOOK_INTEGRATION_ID',
  'OutlookAuthProvider',
  'OutlookProviderFactory',
  'SentItemsReader',
  'createOutlookIntegration',
  'default',
  'outlookIntegration',
  'outlookTokenCachePath',
];

function probe(project: string, lines: readonly string[]): unknown {
  const result = consumerRunner(project, pm).node(['--input-type=module', '-e', lines.join('\n')]);

  if (result.status !== 0) {
    throw new Error(`probe exited with ${String(result.status)}:\n${result.stderr}${result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

function skipped(message: string): void {
  process.stdout.write(`  --  ${message}\n`);
}

function verifyPublishedManifest(project: string): void {
  const published = probe(project, [
    "import { createRequire } from 'node:module';",
    "const fromProject = createRequire(process.cwd() + '/package.json');",
    `console.log(JSON.stringify(fromProject('${manifest.name}/package.json')));`,
  ]) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  check(!JSON.stringify(published).includes('workspace:'), 'the published manifest has no workspace: ranges');
  check(
    published.peerDependencies?.['@mailroll/core'] === `^${core.version}` &&
      published.peerDependencies['mailroll'] === `^${mailroll.version}` &&
      published.peerDependenciesMeta?.['mailroll']?.optional === true,
    `it asks for @mailroll/core@^${core.version} and, optionally, mailroll@^${mailroll.version} as peers`,
  );
  check(
    published.dependencies?.['@azure/msal-node'] !== undefined && published.dependencies['zod'] !== undefined,
    'it brings its own @azure/msal-node and zod',
  );
}

function verifyNoBundledCore(project: string): void {
  if (plugAndPlay) {
    skipped("bundled-code scan skipped: Yarn Plug'n'Play keeps packages inside zip archives");

    return;
  }

  const { definitions, copies } = copiedDefinitions(
    join(project, 'node_modules', core.name, 'dist'),
    join(project, 'node_modules', manifest.name, 'dist'),
  );

  check(
    definitions > 0 && copies.length === 0,
    `${manifest.name} contains none of the ${String(definitions)} function and class definitions of ${core.name} (found in: ${copies.join(', ') || 'none'})`,
  );
}

function verifyLibraryWithoutMailroll(project: string): void {
  const result = probe(project, [
    "import { createRequire } from 'node:module';",
    "const fromProject = createRequire(process.cwd() + '/package.json');",
    "const resolvable = (name) => { try { fromProject.resolve(name + '/package.json'); return true; } catch { return false; } };",
    `const outlook = await import('${manifest.name}');`,
    `const core = await import('${core.name}');`,
    'console.log(JSON.stringify({',
    "  mailroll: resolvable('mailroll'),",
    '  keys: Object.keys(outlook).sort(),',
    '  valid: core.validateIntegrationDescriptor(outlook.default).ok,',
    '  id: outlook.default.id,',
    '  sameDefault: outlook.default === outlook.outlookIntegration,',
    '}));',
  ]) as { mailroll: boolean; keys: string[]; valid: boolean; id: string; sameDefault: boolean };

  check(!result.mailroll, 'the library installs next to @mailroll/core without mailroll');
  check(
    JSON.stringify(result.keys) === JSON.stringify([...RUNTIME_EXPORTS].sort()),
    `it exports ${String(RUNTIME_EXPORTS.length)} runtime names (got: ${result.keys.join(', ')})`,
  );
  check(
    result.valid && result.id === 'outlook' && result.sameDefault,
    'its default export is the outlook descriptor, and it passes the public validation of the installed Core',
  );

  if (plugAndPlay) {
    skipped("type check skipped: tsc does not resolve Yarn Plug'n'Play installs");
  } else {
    compileTypes(
      project,
      'consumer',
      [
        `import outlook, { createOutlookIntegration, GraphClient, type OutlookConnectionConfig, SentItemsReader } from '${manifest.name}';`,
        `import { type IntegrationDescriptor, validateIntegrationDescriptor } from '${core.name}';`,
        'export const descriptor: IntegrationDescriptor<Readonly<Record<string, never>>> = outlook;',
        'export const custom = createOutlookIntegration({ fetchFn: fetch });',
        'export const valid = validateIntegrationDescriptor(custom).ok;',
        "export const config: OutlookConnectionConfig = { tenantId: 't', clientId: 'c', tokenCachePath: 'p' };",
        'export const classes = [GraphClient, SentItemsReader];',
      ].join('\n'),
      {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2023',
        exactOptionalPropertyTypes: true,
        types: ['node'],
        typeRoots: nodeTypeRoots(),
      },
    );
    check(true, 'its types compile in a strict nodenext consumer without mailroll');
  }

  const tool = consumerRunner(project, pm).bin('mailroll-outlook', [
    'export-sent',
    '-c',
    'acme/onboarding',
    '--connection',
    'outlook-1',
    '--since',
    '2026-01-15',
    '-o',
    'sent.json',
  ]);

  check(
    tool.status === 2 &&
      tool.stderr.includes('which is not installed in this project') &&
      !existsSync(join(project, 'sent.json')),
    'mailroll-outlook export-sent without mailroll stops with exit code 2 and asks to install it',
  );
}

function verifyIncompatiblePeerIsRefused(outlookTarball: string, coreTarball: string): void {
  const work = mkdtempSync(join(tmpdir(), 'mailroll-outlook-peer-'));

  try {
    const unpacked = join(work, 'unpacked');

    spawnSync('tar', ['-xzf', outlookTarball, '-C', work], { stdio: 'ignore' });
    cpSync(join(work, 'package'), unpacked, { recursive: true });

    const alteredManifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')) as PackageManifest & {
      peerDependencies: Record<string, string>;
    };

    alteredManifest.peerDependencies['@mailroll/core'] = '^9.0.0';
    writeFileSync(join(unpacked, 'package.json'), JSON.stringify(alteredManifest));

    const altered = packDirectory(unpacked, work);
    const project = join(work, 'consumer');

    mkdirSync(project);
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        private: true,
        type: 'module',
        dependencies: { [core.name]: `file:${coreTarball}`, [manifest.name]: `file:${altered}` },
      }),
    );

    const args = ['install', '--no-audit', '--no-fund', '--ignore-scripts'];
    const install =
      process.platform === 'win32'
        ? spawnSync(windowsCommandLine('npm', args), { cwd: project, shell: true, encoding: 'utf8' })
        : spawnSync('npm', args, { cwd: project, encoding: 'utf8' });

    check(
      install.status !== 0 && `${install.stdout}${install.stderr}`.includes('ERESOLVE'),
      'npm refuses to install an Outlook build whose @mailroll/core peer range the installed Core does not satisfy',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const outlookTarball = tarballIn(packDir, manifest);
const coreTarball = tarballIn(packDir, core);

withConsumer(
  pm,
  new Map([
    [manifest.name, outlookTarball],
    [core.name, coreTarball],
  ]),
  {},
  (project) => {
    verifyPublishedManifest(project);
    verifyNoBundledCore(project);
    verifyLibraryWithoutMailroll(project);
  },
);

if (pm === 'npm') {
  verifyIncompatiblePeerIsRefused(outlookTarball, coreTarball);
}
