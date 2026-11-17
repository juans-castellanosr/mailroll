import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type Logger, type SendSelection, SignInRequiredError } from '@mailroll/core';
import { runSelection } from 'mailroll';
import { createOutlookIntegration } from '../src/outlook-integration';

const PLUGIN = `
export default {
  prepare: async () => ({
    listRecipients: async (source) => {
      for await (const _row of source.read()) {}
      return { accepted: ['row@x.co'], rejected: [] };
    },
    run: async (deps) => {
      const bound = deps.senders.get(deps.connectionIds[0]);
      const outcome = await bound.sender.send(
        { to: 'row@x.co', subject: 's', html: '<p>x</p>' },
        { attemptId: 'a', call: 1 },
        { keepSentCopy: false },
      );
      if (outcome.outcome !== 'accepted') throw new Error(outcome.detail);
      return { total: 1, sent: 1, failed: 0, uncertain: 0, notAttempted: 0, skipped: 0, results: [] };
    },
  }),
};
`;

const SECRETS = { G_C__OUTLOOK_1__TENANT_ID: 'tenant', G_C__OUTLOOK_1__CLIENT_ID: 'client' };
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const live: SendSelection = {
  campaignId: 'g/c',
  targets: [{ templateId: 'welcome', cc: [] }],
  connectionIds: ['outlook-1'],
  policy: { kind: 'pending' },
  mode: { kind: 'live' },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-outlook-run-'));
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 202 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function scaffold(): string {
  const base = join(root, 'campaigns', 'g', 'c');

  write(join(base, 'campaign.config.json'), JSON.stringify({ displayName: 'C' }));
  write(
    join(base, 'connections', 'outlook-1.json'),
    JSON.stringify({ id: 'outlook-1', kind: 'outlook', mailbox: 's@org.co' }),
  );
  write(
    join(base, 'templates', 'welcome', 'config', 'template.config.json'),
    JSON.stringify({ ccPolicy: 'optional', connectionIds: ['outlook-1'], context: {} }),
  );
  write(join(base, 'templates', 'welcome', 'code', 'plugin.ts'), PLUGIN);
  write(join(base, 'templates', 'welcome', 'data', 'list.csv'), 'email\nrow@x.co\n');

  return join(root, 'campaigns');
}

describe('the Outlook integration run by mailroll', () => {
  it('keeps the Outlook token cache exactly where it was: <TOKEN_CACHE_PATH>/<campaign key>/<connection key>.json', async () => {
    const seen: string[] = [];
    const tokens = join(root, 'tokens');

    await runSelection(live, {
      campaignsRoot: scaffold(),
      logger: silent,
      env: { ...SECRETS, TOKEN_CACHE_PATH: tokens },
      integrations: [
        createOutlookIntegration({
          authFor: (config) => {
            seen.push(config.tokenCachePath);

            return { getAccessToken: () => Promise.resolve('TOKEN') };
          },
        }),
      ],
    });

    expect(seen).toEqual([join(tokens, 'g_c', 'outlook_1.json')]);
  });

  it('receives its tenant and client ids from the same environment variables, and the sign-in mode', async () => {
    const contexts: { connectionId: string; interactive: boolean; secrets: Readonly<Record<string, string>> }[] = [];

    await runSelection(live, {
      campaignsRoot: scaffold(),
      logger: silent,
      env: SECRETS,
      signIn: 'cached-only',
      integrations: [
        createOutlookIntegration({
          authFor: (_config, context) => {
            contexts.push({
              connectionId: context.connectionId,
              interactive: context.interactive,
              secrets: context.secrets,
            });

            return { getAccessToken: () => Promise.resolve('TOKEN') };
          },
        }),
      ],
    });

    expect(contexts).toEqual([
      { connectionId: 'outlook-1', interactive: false, secrets: { TENANT_ID: 'tenant', CLIENT_ID: 'client' } },
    ]);
  });

  it('reports a missing secret with the same message as before, before signing in or locking', async () => {
    await expect(
      runSelection(live, {
        campaignsRoot: scaffold(),
        logger: silent,
        env: {},
        integrations: [createOutlookIntegration()],
      }),
    ).rejects.toThrow(new ConfigError('missing environment secret G_C__OUTLOOK_1__TENANT_ID'));
  });

  it('never waits for a sign-in without a terminal, and takes no lock', async () => {
    const campaignsRoot = scaffold();

    await expect(
      runSelection(live, {
        campaignsRoot,
        logger: silent,
        env: {
          G_C__OUTLOOK_1__TENANT_ID: '00000000-0000-0000-0000-000000000001',
          G_C__OUTLOOK_1__CLIENT_ID: '00000000-0000-0000-0000-000000000002',
          TOKEN_CACHE_PATH: join(root, 'tokens'),
        },
        signIn: 'cached-only',
        integrations: [createOutlookIntegration()],
      }),
    ).rejects.toThrow(SignInRequiredError);
    expect(existsSync(join(campaignsRoot, 'g', 'c', 'templates', 'welcome', '.state', 'list.json.lock'))).toBe(false);
  });

  it('is not active unless it is given, even in a dry run', async () => {
    await expect(
      runSelection({ ...live, mode: { kind: 'dry-run' } }, { campaignsRoot: scaffold(), logger: silent }),
    ).rejects.toThrow('connection "outlook-1" uses the integration "outlook", which is not active (active: none)');
  });
});
