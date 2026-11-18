import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureNode,
  consumerRunner,
  copiedDefinitions,
  check,
  compileTypes,
  nodeTypeRoots,
  type PackageManifest,
  parseVerifyArgs,
  readManifest,
  runModule,
  tarballIn,
  withConsumer,
} from '../../../scripts/consumer-project.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readManifest(PACKAGE);
const { packDir, pm } = parseVerifyArgs(process.argv.slice(2));

function workspaceDependencies(): readonly PackageManifest[] {
  const requireFromPackage = createRequire(join(PACKAGE, 'package.json'));

  return Object.entries(manifest.dependencies ?? {})
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => readManifest(dirname(requireFromPackage.resolve(`${name}/package.json`))));
}

const siblings = workspaceDependencies();

function coreDependency(): PackageManifest {
  const found = siblings.find((sibling) => sibling.name.endsWith('/core'));

  if (found === undefined) {
    throw new Error(`${manifest.name} declares no workspace dependency on the core package`);
  }

  return found;
}

const core = coreDependency();

function mjmlPeerRange(): string {
  const range = manifest.peerDependencies?.['mjml'];

  if (range === undefined) {
    throw new Error('package.json declares no mjml peer dependency');
  }

  return range;
}

function verifyManifest(project: string): void {
  const installed = JSON.parse(readFileSync(join(project, 'node_modules', manifest.name, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const workspaceRanges = Object.entries(installed.dependencies ?? {}).filter(([, range]) =>
    range.startsWith('workspace:'),
  );

  check(workspaceRanges.length === 0, 'the published manifest has no workspace: dependency ranges');
  check(
    siblings.every((sibling) => installed.dependencies?.[sibling.name] === `^${sibling.version}`),
    `the published manifest depends on ${siblings.map((s) => `${s.name}@^${s.version}`).join(', ')}, so one compatible copy is shared`,
  );
}

function verifyNoBundledCore(project: string): void {
  const { definitions, copies } = copiedDefinitions(
    join(project, 'node_modules', core.name, 'dist'),
    join(project, 'node_modules', manifest.name, 'dist'),
  );

  check(
    definitions > 0 && copies.length === 0,
    `${manifest.name} contains none of the ${String(definitions)} function and class definitions of ${core.name} (found in: ${copies.join(', ') || 'none'})`,
  );
}

function verifyImports(project: string): void {
  const result = JSON.parse(
    runModule(
      project,
      'probe.mjs',
      [
        "import { createRequire } from 'node:module';",
        "import { realpathSync } from 'node:fs';",
        "const node = await import('mailroll');",
        "const facade = await import('mailroll/core');",
        `const core = await import('${core.name}');`,
        "const fromProject = realpathSync(createRequire(import.meta.url).resolve('" + core.name + "'));",
        "const mailrollDir = realpathSync(createRequire(import.meta.url).resolve('mailroll/package.json'));",
        "const fromMailroll = realpathSync(createRequire(mailrollDir).resolve('" + core.name + "'));",
        'const coreKeys = Object.keys(core).sort();',
        'console.log(JSON.stringify({',
        "  node: ['runSelection', 'buildSelection', 'getCampaignStatus', 'FileStateStore', 'planRun'].filter((k) => !(k in node)),",
        "  facade: ['planRun', 'runTemplate', 'definePlugin', 'MemoryStateStore', 'parseEmailAddress'].filter((k) => !(k in facade)),",
        "  facadeHasNodeOnly: 'FileStateStore' in facade || 'runSelection' in facade,",
        '  sameKeys: JSON.stringify(Object.keys(facade).sort()) === JSON.stringify(coreKeys),',
        '  notShared: coreKeys.filter((k) => facade[k] !== core[k] || node[k] !== core[k]),',
        '  values: coreKeys.length,',
        '  oneCopy: fromProject === fromMailroll,',
        '}));',
      ].join('\n'),
    ),
  ) as {
    node: string[];
    facade: string[];
    facadeHasNodeOnly: boolean;
    sameKeys: boolean;
    notShared: string[];
    values: number;
    oneCopy: boolean;
  };

  check(result.node.length === 0, `"mailroll" exports the Node SDK (missing: ${result.node.join(', ') || 'none'})`);
  check(
    result.facade.length === 0,
    `"mailroll/core" exports the core API (missing: ${result.facade.join(', ') || 'none'})`,
  );
  check(!result.facadeHasNodeOnly, '"mailroll/core" exposes no Node-only API');
  check(result.sameKeys, `"mailroll/core" exports exactly the runtime API of "${core.name}"`);
  check(
    result.notShared.length === 0,
    `all ${String(result.values)} runtime exports of "mailroll", "mailroll/core" and "${core.name}" are the same instances (different: ${result.notShared.join(', ') || 'none'})`,
  );
  check(result.oneCopy, `the project and mailroll resolve the same single copy of "${core.name}"`);
}

function verifyTypes(project: string): void {
  compileTypes(
    project,
    'consumer',
    [
      "import { buildSelection, type FileStateStore, type TemplateRunResult } from 'mailroll';",
      "import { planRun, type ResendPolicy } from 'mailroll/core';",
      "import type * as Facade from 'mailroll/core';",
      `import type * as Core from '${core.name}';`,
      'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
      "const policy: ResendPolicy = { kind: 'pending' };",
      "export const selection = buildSelection({ campaignId: 'g/c', targets: [{ templateId: 't' }], connectionIds: ['c'], policy, mode: { kind: 'dry-run' } });",
      'export type Result = TemplateRunResult;',
      'export const plan: typeof planRun = planRun;',
      'export const sameOutcome: Equal<Facade.SendOutcome, Core.SendOutcome> = true;',
      'export const sameDescriptor: Equal<Facade.IntegrationDescriptor, Core.IntegrationDescriptor> = true;',
      'export const sameError: Equal<typeof Facade.SendError, typeof Core.SendError> = true;',
      'export const samePlan: Equal<typeof Facade.planRun, typeof Core.planRun> = true;',
      "export const loadsCurrent: Equal<Awaited<ReturnType<Core.StateStore['load']>>, Core.TemplateState> = true;",
      "export const fileLoadsCurrent: Equal<Awaited<ReturnType<FileStateStore['load']>>, Core.TemplateState> = true;",
      "export const noHistory: Equal<Extract<keyof TemplateRunResult, 'history'>, never> = true;",
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
  check(
    true,
    `the published types compile in a strict nodenext consumer, and "mailroll/core" types are "${core.name}" types`,
  );
}

function packagesNamed(dir: string, matches: (name: string) => boolean): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }

    const path = join(dir, entry.name);

    return matches(entry.name) ? [path] : packagesNamed(path, matches);
  });
}

function verifyNoProviderInstalled(project: string): void {
  const providers = packagesNamed(
    join(project, 'node_modules'),
    (name) =>
      name === 'msal-node' ||
      name.startsWith('@azure+msal-node') ||
      name === 'outlook' ||
      name.startsWith('@mailroll+outlook'),
  );
  const published = JSON.parse(readFileSync(join(project, 'node_modules', manifest.name, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const declared = Object.keys({ ...published.dependencies, ...published.peerDependencies });

  check(
    providers.length === 0 && !declared.includes('@azure/msal-node') && !declared.includes('@mailroll/outlook'),
    `a base install has no MSAL and no Outlook anywhere in node_modules, and the manifest does not ask for them (found: ${providers.join(', ') || 'none'})`,
  );
}

function verifyCli(project: string): void {
  const bin = join(project, 'node_modules', 'mailroll', 'dist', 'cli.mjs');
  const cli = (args: readonly string[]): string =>
    captureNode([bin, ...args], { cwd: project, env: { ...process.env, NO_COLOR: '1' } });

  check(cli(['--version']).trim() === manifest.version, `mailroll --version prints ${manifest.version}`);
  check(cli(['--help']).includes('Usage: mailroll'), 'mailroll --help prints the usage');

  cpSync(join(PACKAGE, 'tests', 'fixtures', 'campaigns'), join(project, 'campaigns'), { recursive: true });

  const refused = consumerRunner(project, pm).node([
    bin,
    'send',
    '-c',
    'acme/onboarding',
    '-t',
    'welcome',
    '--connection',
    'outlook-1',
    '-m',
    'dry-run',
    '--cc',
    '',
    '--json',
    '-q',
  ]);

  check(
    refused.status === 1 &&
      refused.stdout === '' &&
      refused.stderr.includes('uses the integration "outlook", which is not active (active: none)'),
    'without @mailroll/outlook installed and declared, the example campaign is refused even in a dry run: nothing is built in',
  );
  check(cli(['status', '--json']).includes('"acme/onboarding"'), 'mailroll status --json reads the campaigns');

  const template = join(project, 'mjml-template');

  mkdirSync(join(template, 'view'), { recursive: true });
  writeFileSync(
    join(template, 'view', 'template.mjml'),
    '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
  );
  cli(['build-template', template]);
  check(
    readFileSync(join(template, 'view', 'compiled.html'), 'utf8').includes('Hi {{firstName}}'),
    `mailroll build-template compiles MJML with the mjml peer (${mjmlPeerRange()})`,
  );
}

const tarballs = new Map([
  [manifest.name, tarballIn(packDir, manifest)],
  ...siblings.map((sibling): [string, string] => [sibling.name, tarballIn(packDir, sibling)]),
]);

withConsumer(pm, tarballs, { mjml: mjmlPeerRange() }, (project) => {
  verifyManifest(project);
  verifyNoProviderInstalled(project);
  verifyNoBundledCore(project);
  verifyImports(project);
  verifyTypes(project);
  verifyCli(project);
});
