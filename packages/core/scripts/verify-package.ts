import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  compileTypes,
  installedPackages,
  nodeTypeRoots,
  parseVerifyArgs,
  readManifest,
  runModule,
  tarballIn,
  withConsumer,
} from '../../../scripts/consumer-project.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readManifest(PACKAGE);
const { packDir, pm } = parseVerifyArgs(process.argv.slice(2));

const PUBLIC_API = [
  'SENDER_CONTRACT',
  'INTEGRATION_KIND',
  'validateIntegrationDescriptor',
  'validateSendOutcome',
  'settleSend',
  'planRun',
  'runTemplate',
  'definePlugin',
  'MemoryStateStore',
  'parseEmailAddress',
  'SendError',
];

const TYPE_CONSUMER = [
  `import { type IntegrationDescriptor, type SendOutcome, type ValidationOutcome, validateIntegrationDescriptor, parseEmailAddress } from '${manifest.name}';`,
  "const outcome: SendOutcome = { outcome: 'accepted' };",
  'const address: ValidationOutcome<unknown> = parseEmailAddress("a@b.co");',
  'export const checked = (descriptor: IntegrationDescriptor) => validateIntegrationDescriptor(descriptor);',
  'export { outcome, address };',
].join('\n');

function verifyStandalone(project: string): void {
  check(
    Object.keys(manifest.dependencies ?? {}).length === 0 && Object.keys(manifest.peerDependencies ?? {}).length === 0,
    `${manifest.name} declares no dependencies and no peers`,
  );

  const installed = installedPackages(project);

  check(
    installed.length === 1 && installed[0] === manifest.name,
    `the install contains only ${manifest.name} (found: ${installed.join(', ')})`,
  );
}

function verifyRuntime(project: string): void {
  const result = JSON.parse(
    runModule(
      project,
      'probe.mjs',
      [
        `const core = await import('${manifest.name}');`,
        `const missing = ${JSON.stringify(PUBLIC_API)}.filter((name) => !(name in core));`,
        "const parsed = core.parseEmailAddress('Ana@Example.co');",
        'const store = new core.MemoryStateStore();',
        'console.log(JSON.stringify({ missing, parsed: parsed.ok, contract: core.SENDER_CONTRACT, store: typeof store.load }));',
      ].join('\n'),
    ),
  ) as { missing: string[]; parsed: boolean; contract: string; store: string };

  check(
    result.missing.length === 0,
    `${manifest.name} exports its public API (missing: ${result.missing.join(', ') || 'none'})`,
  );
  check(
    result.parsed && result.contract === 'sender/0' && result.store === 'function',
    `${manifest.name} runs without mailroll`,
  );
}

function verifyTypes(project: string): void {
  compileTypes(project, 'node-consumer', TYPE_CONSUMER, {
    module: 'nodenext',
    moduleResolution: 'nodenext',
    target: 'es2023',
    exactOptionalPropertyTypes: true,
    types: ['node'],
    typeRoots: nodeTypeRoots(),
  });
  check(true, 'the published types compile in a strict nodenext consumer');
  compileTypes(project, 'browser-consumer', TYPE_CONSUMER, {
    module: 'esnext',
    moduleResolution: 'bundler',
    target: 'es2023',
    lib: ['es2023', 'dom'],
    exactOptionalPropertyTypes: true,
    types: [],
  });
  check(true, 'the published types compile in a strict browser consumer without Node.js types');
}

withConsumer(pm, new Map([[manifest.name, tarballIn(packDir, manifest)]]), {}, (project) => {
  verifyStandalone(project);
  verifyRuntime(project);
  verifyTypes(project);
});
