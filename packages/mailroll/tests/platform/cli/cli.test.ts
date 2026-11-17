import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutput } from '../../../src/platform/cli/output';
import { runCli } from '../../../src/platform/cli/program';
import { createTestSender } from '../../support/test-sender';

const PACKAGE = resolve(import.meta.dirname, '../../..');
const MAIN = join(PACKAGE, 'src/platform/cli/main.ts');
const TSX = pathToFileURL(createRequire(join(PACKAGE, 'package.json')).resolve('tsx')).href;
const CAMPAIGNS = join(PACKAGE, 'tests/fixtures/campaigns');

const SEND = ['send', '-c', 'acme/onboarding', '-t', 'welcome', '--connection', 'outlook-1'];

const ANSI = `${String.fromCharCode(27)}[`;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mailroll-cli-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function baseEnv(): NodeJS.ProcessEnv {
  const ignored =
    /^(TEST_RECIPIENT|CC_RECIPIENT|TOKEN_CACHE_PATH|NO_COLOR|FORCE_COLOR|NODE_OPTIONS)$|__(TENANT|CLIENT)_ID$/;

  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !ignored.test(key)));
}

function cli(args: readonly string[], env: Readonly<Record<string, string>> = {}): Run {
  const result = spawnSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
    env: { ...baseEnv(), TSX_TSCONFIG_PATH: join(PACKAGE, 'tsconfig.json'), ...env },
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function collector(append: (text: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      append(String(chunk));
      done();
    },
  });
}

async function inProcess(args: readonly string[]): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const logs = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);

    return true;
  });

  try {
    const status = await runCli(args, {
      out: createOutput({
        stdout: collector((text) => (stdout += text)),
        stderr: collector((text) => (stderr += text)),
      }),
      env: {},
      interactive: false,
      cwd,
      loadIntegrations: () => Promise.resolve([createTestSender({ id: 'outlook' })]),
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
    });

    return { status, stdout, stderr };
  } finally {
    logs.mockRestore();
  }
}

describe('mailroll CLI', { timeout: 60_000 }, () => {
  it('prints help on stdout with exit code 0', () => {
    const run = cli(['--help']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage: mailroll');
    expect(run.stdout).toContain('Exit codes:');
  });

  it('prints the package version', () => {
    const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { version: string };
    const run = cli(['--version']);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(version);
  });

  it('never waits for a menu answer without a terminal: usage on stderr, exit code 2', () => {
    const run = cli([]);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Usage: mailroll');
  });

  it.each([
    ['an unknown option', ['--bogus']],
    ['an unknown command', ['sned']],
    ['a missing required option', ['send', '-c', 'acme/onboarding']],
    ['an invalid --mode', [...SEND, '-m', 'later']],
    ['a live send without --confirm', ['-C', CAMPAIGNS, ...SEND, '-m', 'live', '--cc', '']],
    ['an option that does not apply', ['-C', CAMPAIGNS, ...SEND, '-m', 'dry-run', '--to', 'qa@example.com']],
  ])('rejects %s with exit code 2 and nothing on stdout', (_case, args) => {
    const run = cli(args);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/error/);
  });

  it('rejects a CC that would need a prompt with exit code 2 and nothing on stdout, with the integration active', async () => {
    const run = await inProcess(['-C', CAMPAIGNS, ...SEND, '-m', 'dry-run']);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/error/);
  });

  it('refuses the example in dry-run when its integration is not active, before rendering anything', () => {
    const run = cli(['-C', CAMPAIGNS, ...SEND, '-m', 'dry-run', '--cc', '']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('connection "outlook-1" uses the integration "outlook", which is not active');
    expect(run.stdout).toBe('');
  });

  it('runs the example in dry-run with a JSON summary on stdout and logs on stderr', async () => {
    const run = await inProcess(['-C', CAMPAIGNS, ...SEND, '-m', 'dry-run', '--cc', '', '--json']);

    expect(run.status).toBe(0);

    const summary = JSON.parse(run.stdout) as unknown;

    expect(summary).toMatchObject({
      campaignId: 'acme/onboarding',
      mode: 'dry-run',
      needsAttention: false,
      lists: [{ templateId: 'welcome', counts: { total: 4, sent: 3, skipped: 1 } }],
    });
    expect(run.stderr).toContain('"event":"recipient.rendered"');
  });

  it('keeps --json valid when a CSV holds invisible characters', async () => {
    const campaigns = join(cwd, 'campaigns');

    cpSync(CAMPAIGNS, campaigns, { recursive: true });
    appendFileSync(
      join(campaigns, 'acme/onboarding/templates/welcome/data/recipients.csv'),
      'zero\u200bwidth@example.com,Zed,Free\n',
    );

    const run = await inProcess(['-C', campaigns, ...SEND, '-m', 'dry-run', '--cc', '', '--json']);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ lists: [{ counts: { skipped: 2 } }] });
  });

  it('writes previews only where --previews-dir says', async () => {
    const run = await inProcess([
      '-C',
      CAMPAIGNS,
      '-q',
      ...SEND,
      '-m',
      'dry-run',
      '--cc',
      '',
      '--write-previews',
      '--previews-dir',
      join(cwd, 'out'),
    ]);

    expect(run.status).toBe(0);
    expect(existsSync(join(cwd, 'out', 'welcome', 'recipients', '0001-ada@example.com.html'))).toBe(true);
    expect(run.stderr).not.toContain('recipient.rendered');
  });

  it('exits with 1 from status when a template cannot be read', () => {
    const campaigns = join(cwd, 'campaigns');

    cpSync(CAMPAIGNS, campaigns, { recursive: true });
    rmSync(join(campaigns, 'acme/onboarding/templates/welcome/view/compiled.html'));

    const run = cli(['-C', campaigns, 'status', '--json']);

    expect(run.status).toBe(1);

    const [campaign] = JSON.parse(run.stdout) as { templates: { templateId: string; problem?: string }[] }[];

    expect(campaign?.templates[0]?.templateId).toBe('welcome');
    expect(campaign?.templates[0]?.problem).toContain('compiled');
  });

  it('reports list status as JSON', () => {
    const run = cli(['-C', CAMPAIGNS, 'status', '--json']);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject([
      {
        campaignId: 'acme/onboarding',
        templates: [{ templateId: 'welcome', lists: [{ counts: { pending: 3, rejected: 1 } }] }],
      },
    ]);
  });

  it('colors output only when allowed, and --no-color always wins', () => {
    expect(cli(['-C', CAMPAIGNS, 'status'], { FORCE_COLOR: '1' }).stdout).toContain(ANSI);
    expect(cli(['-C', CAMPAIGNS, '--no-color', 'status'], { FORCE_COLOR: '1' }).stdout).not.toContain(ANSI);
    expect(cli(['-C', CAMPAIGNS, 'status']).stdout).not.toContain(ANSI);
  });

  it('compiles a template view with build-template', () => {
    const template = join(cwd, 'welcome');

    mkdirSync(join(template, 'view'), { recursive: true });
    writeFileSync(
      join(template, 'view', 'template.mjml'),
      '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
    );

    const run = cli(['build-template', template]);

    expect(run.status).toBe(0);
    expect(readFileSync(join(template, 'view', 'compiled.html'), 'utf8')).toContain('Hi {{firstName}}');
  });

  it('reports a runtime failure with exit code 1', () => {
    const run = cli(['-C', join(cwd, 'nowhere'), ...SEND, '-m', 'dry-run', '--cc', '']);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/error:/);
  });
});
