import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as mailroll from 'mailroll';
import { forTerminal } from '../../src/cli/cli-output';
import { runOutlookCli } from '../../src/cli/program';
import type { OutlookConnectionConfig } from '../../src/outlook-auth-provider';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-outlook-rules-'));

  const base = join(root, 'campaigns', 'acme', 'newsletter');
  const write = (path: string, content: unknown): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(content), 'utf8');
  };

  write(join(base, 'campaign.config.json'), { displayName: 'Newsletter' });
  write(join(base, 'connections', 'outlook-1.json'), {
    id: 'outlook-1',
    kind: 'outlook',
    mailbox: 'sender@example.com',
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function exportWith(env: NodeJS.ProcessEnv) {
  const seen: OutlookConnectionConfig[] = [];
  const errors: string[] = [];
  const status = await runOutlookCli(
    [
      '-C',
      join(root, 'campaigns'),
      'export-sent',
      '-c',
      'acme/newsletter',
      '--connection',
      'outlook-1',
      '--since',
      '2026-01-15',
      '-o',
      join(root, 'sent.json'),
    ],
    {
      out: { info: () => undefined, error: (text) => errors.push(text) },
      env,
      interactive: false,
      writeOut: () => undefined,
      loadHost: () => Promise.resolve(mailroll),
      fetchFn: () => Promise.resolve(new Response(JSON.stringify({ value: [] }), { status: 200 })),
      authFor: (config) => {
        seen.push(config);

        return { getAccessToken: () => Promise.resolve('TOKEN') };
      },
    },
  );

  return { status, seen, errors };
}

describe('the rules mailroll-outlook keeps in step with mailroll', () => {
  it('escapes terminal control and invisible characters exactly like mailroll', () => {
    expect(forTerminal('x\u001b[2Ky')).toBe('x\\u{1b}[2Ky');
    expect(forTerminal('a‮b​c')).toBe('a\\u{202e}b\\u{200b}c');
    expect(forTerminal('Zoë Ångström\n\tsent')).toBe('Zoë Ångström\n\tsent');
  });

  it('trims connection secrets and reads them under the same variable names as mailroll', async () => {
    const { status, seen } = await exportWith({
      ACME_NEWSLETTER__OUTLOOK_1__TENANT_ID: ' t ',
      ACME_NEWSLETTER__OUTLOOK_1__CLIENT_ID: 'c',
    });

    expect(status).toBe(0);
    expect(seen.map((config) => [config.tenantId, config.clientId])).toEqual([['t', 'c']]);
  });

  it('treats a secret made only of spaces as missing, with the same message as mailroll', async () => {
    const { status, errors } = await exportWith({
      ACME_NEWSLETTER__OUTLOOK_1__TENANT_ID: '   ',
      ACME_NEWSLETTER__OUTLOOK_1__CLIENT_ID: 'c',
    });

    expect(status).toBe(1);
    expect(errors).toEqual(['missing environment secret ACME_NEWSLETTER__OUTLOOK_1__TENANT_ID']);
  });
});
