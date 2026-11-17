import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as mailroll from 'mailroll';
import type { CliOutput } from '../../src/cli/cli-output';
import { MissingHostError } from '../../src/cli/host';
import { type OutlookCliIo, runOutlookCli } from '../../src/cli/program';
import type { FetchFn } from '../../src/graph-client';
import type { OutlookConnectionConfig } from '../../src/outlook-auth-provider';
import { OUTLOOK_VERSION } from '../../src/version';

const SECRETS = {
  ACME_ONBOARDING__OUTLOOK_1__TENANT_ID: '00000000-0000-0000-0000-000000000001',
  ACME_ONBOARDING__OUTLOOK_1__CLIENT_ID: '00000000-0000-0000-0000-000000000002',
};

let root: string;
let lines: { readonly level: 'info' | 'error'; readonly text: string }[];
let stdout: string;
let requests: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-outlook-export-'));
  lines = [];
  stdout = '';
  requests = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content), 'utf8');
}

function campaign(kind = 'outlook'): string {
  const base = join(root, 'campaigns', 'acme', 'onboarding');

  write(join(base, 'campaign.config.json'), { displayName: 'Onboarding' });
  write(join(base, 'connections', 'outlook-1.json'), { id: 'outlook-1', kind, mailbox: 'sender@example.com' });

  return join(root, 'campaigns');
}

const output: CliOutput = {
  info: (text) => lines.push({ level: 'info', text }),
  error: (text) => lines.push({ level: 'error', text }),
};

const graphPage: FetchFn = (input) => {
  requests.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

  return Promise.resolve(
    new Response(
      JSON.stringify({
        value: [
          {
            subject: 'Welcome to Acme',
            sentDateTime: '2026-01-15T09:30:12Z',
            toRecipients: [{ emailAddress: { address: 'ada@example.com' } }],
            ccRecipients: [],
          },
          {
            subject: null,
            sentDateTime: '2026-01-15T09:30:14Z',
            toRecipients: [{ emailAddress: { address: 'alan@example.org' } }],
            ccRecipients: [{ emailAddress: { address: 'team@example.com' } }],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
};

const signedIn =
  (seen: OutlookConnectionConfig[] = []) =>
  (config: OutlookConnectionConfig) => {
    seen.push(config);

    return { getAccessToken: () => Promise.resolve('TOKEN') };
  };

function io(overrides: Partial<OutlookCliIo> = {}): OutlookCliIo {
  return {
    out: output,
    env: { ...SECRETS, TOKEN_CACHE_PATH: join(root, 'tokens') },
    interactive: false,
    writeOut: (text) => {
      stdout += text;
    },
    loadHost: () => Promise.resolve(mailroll),
    fetchFn: graphPage,
    authFor: signedIn(),
    ...overrides,
  };
}

function exportArgs(campaignsRoot: string, out: string, extra: readonly string[] = []): string[] {
  return [
    '-C',
    campaignsRoot,
    'export-sent',
    '-c',
    'acme/onboarding',
    '--connection',
    'outlook-1',
    '--since',
    '2026-01-15',
    '-o',
    out,
    ...extra,
  ];
}

function errors(): string[] {
  return lines.filter((line) => line.level === 'error').map((line) => line.text);
}

describe('mailroll-outlook export-sent', () => {
  it('writes the same JSON file as before: owner-only, fields in order, oldest first', async () => {
    const out = join(root, 'sent.json');

    await expect(runOutlookCli(exportArgs(campaign(), out), io())).resolves.toBe(0);

    const payload = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;

    expect(Object.keys(payload)).toEqual([
      'exportedAt',
      'campaignId',
      'connectionId',
      'mailbox',
      'since',
      'count',
      'messages',
    ]);
    expect(payload).toMatchObject({
      campaignId: 'acme/onboarding',
      connectionId: 'outlook-1',
      mailbox: 'sender@example.com',
      since: '2026-01-15T00:00:00.000Z',
      count: 2,
      messages: [
        { subject: 'Welcome to Acme', to: ['ada@example.com'], cc: [], sentAt: '2026-01-15T09:30:12Z' },
        { subject: '', to: ['alan@example.org'], cc: ['team@example.com'], sentAt: '2026-01-15T09:30:14Z' },
      ],
    });
    expect(readFileSync(out, 'utf8').endsWith('\n')).toBe(true);
    expect(lines).toEqual([{ level: 'info', text: `exported 2 Sent Items message(s) to ${out}` }]);
    expect(stdout).toBe('');
    expect(requests).toHaveLength(1);

    if (process.platform !== 'win32') {
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
  });

  it('reads the token cache from the same place as before, and asks for the same secrets', async () => {
    const seen: OutlookConnectionConfig[] = [];

    await runOutlookCli(exportArgs(campaign(), join(root, 'sent.json')), io({ authFor: signedIn(seen) }));

    expect(seen).toEqual([
      {
        tenantId: SECRETS.ACME_ONBOARDING__OUTLOOK_1__TENANT_ID,
        clientId: SECRETS.ACME_ONBOARDING__OUTLOOK_1__CLIENT_ID,
        tokenCachePath: join(root, 'tokens', 'acme_onboarding', 'outlook_1.json'),
      },
    ]);
  });

  it('never overwrites a file: an existing output stops the command with exit code 2 and stays as it was', async () => {
    const out = join(root, 'sent.json');

    writeFileSync(out, 'keep me');

    await expect(runOutlookCli(exportArgs(campaign(), out), io())).resolves.toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('keep me');
    expect(errors()).toEqual([`cannot create ${out} (it must not exist yet)`]);
  });

  it.each([
    ['an invalid --since date', ['--since', '2026-13-01'], 'invalid --since date "2026-13-01" (expected YYYY-MM-DD)'],
    ['an unknown option', ['--bogus'], "Unknown option '--bogus'"],
  ])('rejects %s with exit code 2, before reading anything', async (_case, extra, message) => {
    const out = join(root, 'sent.json');

    await expect(runOutlookCli(exportArgs(campaign(), out, extra), io())).resolves.toBe(2);
    expect(errors().join('\n')).toContain(message);
    expect(requests).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it('names every missing required option, with exit code 2', async () => {
    await expect(runOutlookCli(['export-sent', '-c', 'acme/onboarding'], io())).resolves.toBe(2);
    expect(errors()).toEqual([
      "required option '--connection <id>', '--since <YYYY-MM-DD>', '-o, --out <file>' not specified",
    ]);
  });

  it('refuses a connection that does not use the Outlook integration, before signing in', async () => {
    const seen: OutlookConnectionConfig[] = [];

    await expect(
      runOutlookCli(exportArgs(campaign('acme-mail'), join(root, 'sent.json')), io({ authFor: signedIn(seen) })),
    ).resolves.toBe(2);
    expect(errors()).toEqual([
      'export-sent reads Outlook Sent Items, and connection "outlook-1" uses the "acme-mail" integration',
    ]);
    expect(seen).toEqual([]);
  });

  it('reports a missing secret by its environment variable, with exit code 1', async () => {
    await expect(
      runOutlookCli(exportArgs(campaign(), join(root, 'sent.json')), io({ env: { TOKEN_CACHE_PATH: root } })),
    ).resolves.toBe(1);
    expect(errors()).toEqual(['missing environment secret ACME_ONBOARDING__OUTLOOK_1__TENANT_ID']);
  });

  it('asks to install mailroll when the project does not have it, with exit code 2', async () => {
    const missing = new MissingHostError('mailroll cannot be resolved from @mailroll/outlook');

    await expect(
      runOutlookCli(exportArgs(campaign(), join(root, 'sent.json')), io({ loadHost: () => Promise.reject(missing) })),
    ).resolves.toBe(2);
    expect(errors()[0]).toMatch(/reads your campaigns through mailroll, which is not installed in this project/);
  });

  it('refuses a mailroll too old to provide connectionStateLocation, with exit code 2', async () => {
    const { connectionStateLocation: _missing, ...olderHost } = mailroll;

    await expect(
      runOutlookCli(
        exportArgs(campaign(), join(root, 'sent.json')),
        io({ loadHost: () => Promise.resolve(olderHost) }),
      ),
    ).resolves.toBe(2);
    expect(errors()[0]).toMatch(/this mailroll is too old for mailroll-outlook/);
  });

  it('points to the help after an argument error, as the mailroll command did', async () => {
    await expect(runOutlookCli(['export-sent'], io())).resolves.toBe(2);
    expect(lines.at(-1)).toEqual({ level: 'info', text: '(run with --help for usage)' });
  });

  it('never waits for a sign-in without a terminal: no saved sign-in means exit code 2 and no request', async () => {
    const { authFor: _real, ...withoutStandIn } = io();

    await expect(runOutlookCli(exportArgs(campaign(), join(root, 'sent.json')), withoutStandIn)).resolves.toBe(2);
    expect(errors()[0]).toContain('no saved sign-in for sender@example.com');
    expect(requests).toEqual([]);
  });

  it('prints its help and its version on stdout with exit code 0', async () => {
    await expect(runOutlookCli(['--help'], io())).resolves.toBe(0);
    expect(stdout).toContain('Usage: mailroll-outlook');
    expect(stdout).toContain('export-sent');

    stdout = '';

    await expect(runOutlookCli(['--version'], io())).resolves.toBe(0);
    expect(stdout.trim()).toBe(OUTLOOK_VERSION);
  });
});
