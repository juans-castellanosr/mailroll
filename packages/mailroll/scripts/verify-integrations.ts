import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  type CommandResult,
  consumerRunner,
  copiedDefinitions,
  packDirectory,
  type PackageManifest,
  parseVerifyArgs,
  readManifest,
  tarballIn,
  withConsumer,
} from '../../../scripts/consumer-project.ts';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PACKAGE, 'tests', 'fixtures', 'integrations');
const SENDER = 'acme-mailroll-sender';
const TRIPWIRE = 'acme-tripwire';
const manifest = readManifest(PACKAGE);
const { packDir, pm } = parseVerifyArgs(process.argv.slice(2), ['npm', 'pnpm', 'yarn', 'yarn-pnp']);

function workspaceDependencies(): readonly PackageManifest[] {
  const requireFromPackage = createRequire(join(PACKAGE, 'package.json'));

  return Object.entries(manifest.dependencies ?? {})
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => readManifest(dirname(requireFromPackage.resolve(`${name}/package.json`))));
}

function outlookManifest(): PackageManifest {
  return { name: OUTLOOK, version: manifest.version };
}

function json(result: CommandResult, what: string): unknown {
  if (result.status !== 0) {
    throw new Error(`${what} exited with ${String(result.status)}:\n${result.stderr}${result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

interface CampaignStatus {
  readonly campaignId: string;
  readonly templates: readonly { readonly lists: readonly { readonly counts: { readonly sent: number } }[] }[];
}

interface Summary {
  readonly lists: readonly { readonly counts: { readonly sent: number; readonly skipped: number } }[];
}

const OUTLOOK = '@mailroll/outlook';
const DUPLICATED_SMALL_HELPERS = [
  'describeError',
  'errorCode',
  'flushDirectoryHandle',
  'forTerminal',
  'isDirectoryFlushRefusedByWindows',
  'loadDotEnv',
  'syncDirectory',
];
const EXTERNAL_CAMPAIGN = 'acme/beta';
const OUTLOOK_SECRETS = {
  ACME_ONBOARDING__OUTLOOK_1__TENANT_ID: '00000000-0000-0000-0000-000000000001',
  ACME_ONBOARDING__OUTLOOK_1__CLIENT_ID: '00000000-0000-0000-0000-000000000002',
};

function outbox(project: string): readonly string[] {
  const path = join(project, '.secrets', 'tokens', 'acme_beta', 'acme-outbox.jsonl');

  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event)
    : [];
}

function prepareCampaigns(project: string): void {
  const campaigns = join(project, 'campaigns');

  cpSync(join(PACKAGE, 'tests', 'fixtures', 'campaigns'), campaigns, { recursive: true });
  cpSync(join(campaigns, 'acme', 'onboarding'), join(campaigns, 'acme', 'beta'), { recursive: true });
  writeFileSync(
    join(campaigns, 'acme', 'beta', 'connections', 'outlook-1.json'),
    JSON.stringify({ id: 'outlook-1', kind: 'acme-sender', mailbox: 'sender@example.com' }),
  );
  writeFileSync(
    join(project, '.env'),
    Object.entries(OUTLOOK_SECRETS)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
}

function declare(project: string, integrations: readonly string[]): void {
  writeFileSync(join(project, 'mailroll.json'), JSON.stringify({ integrations }));
}

function sendArgs(campaign: string, mode: readonly string[]): string[] {
  return ['send', '-c', campaign, '-t', 'welcome', '--connection', 'outlook-1', ...mode, '--cc', '', '--json', '-q'];
}

function verifyForeignCopyRefused(project: string): void {
  const foreign = join(project, 'vendor', 'node_modules', 'mailroll');

  cpSync(join(project, 'node_modules', 'mailroll'), foreign, { recursive: true, dereference: true });

  const refused = consumerRunner(project, pm).node([
    join(foreign, 'dist', 'cli.mjs'),
    ...sendArgs(EXTERNAL_CAMPAIGN, ['-m', 'dry-run']),
  ]);

  check(
    refused.status !== 0 && refused.stderr.includes('this mailroll is not the copy installed in the project'),
    'a second copy of mailroll run from the project refuses to activate its integrations and names the right command',
  );
}

function verifySingleCore(project: string): void {
  const result = json(
    consumerRunner(project, pm).node([
      '--input-type=module',
      '-e',
      [
        "import { createRequire } from 'node:module';",
        "import { realpathSync } from 'node:fs';",
        "const fromProject = createRequire(process.cwd() + '/package.json');",
        "const locate = (from) => realpathSync(createRequire(realpathSync(fromProject.resolve(from + '/package.json'))).resolve('@mailroll/core'));",
        "console.log(JSON.stringify({ project: realpathSync(fromProject.resolve('@mailroll/core')), mailroll: locate('mailroll'), outlook: locate('@mailroll/outlook') }));",
      ].join('\n'),
    ]),
    'the Core resolution probe',
  ) as { project: string; mailroll: string; outlook: string };

  check(
    result.project === result.mailroll && result.project === result.outlook,
    'the project, mailroll and @mailroll/outlook resolve one single copy of @mailroll/core',
  );
}

function verifyActivation(project: string): void {
  const run = consumerRunner(project, pm);
  const send = (campaign: string, mode: readonly string[]): CommandResult =>
    run.bin('mailroll', sendArgs(campaign, mode));

  prepareCampaigns(project);

  const undeclaredOutlook = send('acme/onboarding', ['-m', 'dry-run']);

  check(
    undeclaredOutlook.status === 1 &&
      undeclaredOutlook.stderr.includes('uses the integration "outlook", which is not active (active: none)'),
    'with @mailroll/outlook installed but not declared, even a dry run refuses Outlook connections: nothing is active by default',
  );

  declare(project, [OUTLOOK, SENDER]);

  const outlookDryRun = json(send('acme/onboarding', ['-m', 'dry-run']), 'the Outlook dry run') as Summary;

  check(
    outlookDryRun.lists[0]?.counts.sent === 3 && outlookDryRun.lists[0].counts.skipped === 1,
    'Outlook, declared in mailroll.json next to an external integration, runs the example campaign in dry-run',
  );

  const externalDryRun = json(send(EXTERNAL_CAMPAIGN, ['-m', 'dry-run']), 'the external dry run') as Summary;

  check(
    externalDryRun.lists[0]?.counts.sent === 3 && outbox(project).length === 0,
    'the external integration, activated by the same mailroll.json, is checked in dry-run but never prepared',
  );

  const live = json(
    send(EXTERNAL_CAMPAIGN, ['-m', 'live', '--confirm']),
    'the live run with the test sender',
  ) as Summary;

  check(
    live.lists[0]?.counts.sent === 3 && outbox(project).join(',') === 'prepare,send,send,send',
    'a live run hands the engine the external integration, which records 3 simulated sends (no email leaves)',
  );

  const outlookLive = send('acme/onboarding', ['-m', 'live', '--confirm']);

  check(
    outlookLive.status === 2 && outlookLive.stderr.includes('no saved sign-in for sender@example.com'),
    'a live Outlook run without a terminal or a saved sign-in stops with exit code 2 before sending',
  );

  const status = json(run.bin('mailroll', ['status', '--json']), 'mailroll status') as readonly CampaignStatus[];
  const sentBy = (id: string): number | undefined =>
    status.find((campaign) => campaign.campaignId === id)?.templates[0]?.lists[0]?.counts.sent;

  check(
    sentBy(EXTERNAL_CAMPAIGN) === 3 && sentBy('acme/onboarding') === 0,
    'the history records the 3 external sends and nothing for the Outlook campaign that could not sign in',
  );
  check(
    !existsSync(join(project, 'acme-tripwire-was-loaded')),
    `${TRIPWIRE} is installed and declared in package.json but not in mailroll.json, and its code never ran`,
  );

  const tool = run.bin('mailroll-outlook', ['--help']);

  check(
    tool.status === 0 && tool.stdout.includes('export-sent'),
    'mailroll-outlook export-sent is available from the installed Outlook package',
  );

  verifySingleCore(project);

  if (pm !== 'yarn-pnp') {
    const ofMailroll = copiedDefinitions(
      join(project, 'node_modules', manifest.name, 'dist'),
      join(project, 'node_modules', OUTLOOK, 'dist'),
    );
    const unexpected = ofMailroll.names.filter((name) => !DUPLICATED_SMALL_HELPERS.includes(name));

    check(
      ofMailroll.definitions > 0 && unexpected.length === 0,
      `${OUTLOOK} bundles none of the ${String(ofMailroll.definitions)} mailroll definitions; it shares only its own copies of the small helpers ${ofMailroll.names.join(', ') || '(none)'} (unexpected: ${unexpected.join(', ') || 'none'})`,
    );
  }

  if (pm === 'npm') {
    verifyForeignCopyRefused(project);
  }

  declare(project, [OUTLOOK, SENDER, 'acme-not-declared']);

  const undeclared = send(EXTERNAL_CAMPAIGN, ['-m', 'live', '--confirm']);

  check(
    undeclared.status !== 0 && undeclared.stderr.includes('"acme-not-declared", which is not declared in'),
    'a listed package the project does not declare is refused with a clear message, before any import',
  );

  declare(project, [OUTLOOK]);

  const deactivated = send(EXTERNAL_CAMPAIGN, ['-m', 'live', '--confirm']);

  check(
    deactivated.status !== 0 &&
      deactivated.stderr.includes('uses the integration "acme-sender", which is not active') &&
      outbox(project).filter((event) => event === 'send').length === 3,
    'removing an integration from mailroll.json deactivates it: its connection is refused and nothing is sent',
  );
}

const packed = mkdtempSync(join(tmpdir(), 'mailroll-fixtures-'));

try {
  const tarballs = new Map([
    [manifest.name, tarballIn(packDir, manifest)],
    ...workspaceDependencies().map((sibling): [string, string] => [sibling.name, tarballIn(packDir, sibling)]),
    [OUTLOOK, tarballIn(packDir, outlookManifest())],
    [SENDER, packDirectory(join(FIXTURES, SENDER), packed)],
    [TRIPWIRE, packDirectory(join(FIXTURES, TRIPWIRE), packed)],
  ]);

  withConsumer(pm, tarballs, {}, verifyActivation);
} finally {
  rmSync(packed, { recursive: true, force: true });
}
