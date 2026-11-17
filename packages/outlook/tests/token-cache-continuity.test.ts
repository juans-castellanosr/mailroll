import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PublicClientApplication } from '@azure/msal-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Connection, type EmailAddress, parseEmailAddress } from '@mailroll/core';
import { connectionStateLocation } from 'mailroll';
import { outlookTokenCachePath } from '../src/outlook-integration';
import { OutlookAuthProvider } from '../src/outlook-auth-provider';

function address(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error(outcome.reasons.join('; '));
  }

  return outcome.value;
}

const HOME_ACCOUNT = 'uid-1.utid-1';
const ENVIRONMENT = 'login.microsoftonline.com';
const CLIENT_ID = '00000000-0000-0000-0000-000000000002';

function unsignedIdToken(username: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'none', typ: 'JWT' })}.${part({
    aud: CLIENT_ID,
    iss: 'https://login.microsoftonline.com/utid-1/v2.0',
    tid: 'utid-1',
    oid: 'uid-1',
    preferred_username: username,
    name: 'Sender',
    exp: 4_102_444_800,
  })}.`;
}

function savedCache(username: string): string {
  return JSON.stringify({
    Account: {
      [`${HOME_ACCOUNT}-${ENVIRONMENT}-utid-1`]: {
        home_account_id: HOME_ACCOUNT,
        environment: ENVIRONMENT,
        realm: 'utid-1',
        local_account_id: 'uid-1',
        username,
        authority_type: 'MSSTS',
        name: 'Sender',
      },
    },
    IdToken: {
      [`${HOME_ACCOUNT}-${ENVIRONMENT}-idtoken-${CLIENT_ID}-utid-1---`]: {
        home_account_id: HOME_ACCOUNT,
        environment: ENVIRONMENT,
        credential_type: 'IdToken',
        client_id: CLIENT_ID,
        secret: unsignedIdToken(username),
        realm: 'utid-1',
      },
    },
    AccessToken: {},
    RefreshToken: {},
    AppMetadata: {},
  });
}

let tokens: string;

beforeEach(() => {
  tokens = mkdtempSync(join(tmpdir(), 'mailroll-outlook-cache-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tokens, { recursive: true, force: true });
});

describe('a token cache written before M3', () => {
  it('is read from the same path and reused without a new sign-in, and is not deleted or rewritten', async () => {
    const location = connectionStateLocation({
      env: { TOKEN_CACHE_PATH: tokens },
      campaignId: 'acme/onboarding',
      connectionId: 'outlook-1',
    });
    const cachePath = outlookTokenCachePath(location.stateDirectory, location.stateKey);
    const saved = savedCache('sender@example.com');

    expect(cachePath).toBe(join(tokens, 'acme_onboarding', 'outlook_1.json'));
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, saved, { mode: 0o600 });

    const silent = vi
      .spyOn(PublicClientApplication.prototype, 'acquireTokenSilent')
      .mockImplementation((request) => Promise.resolve({ accessToken: `T-${request.account.username}` } as never));
    const deviceCode = vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode');
    const connection: Connection = { id: 'outlook-1', kind: 'outlook', mailbox: address('sender@example.com') };
    const provider = new OutlookAuthProvider(
      () => ({ tenantId: 'utid-1', clientId: CLIENT_ID, tokenCachePath: cachePath }),
      { announce: () => undefined, signIn: 'cached-only' },
    );

    await expect(provider.getAccessToken(connection)).resolves.toBe('T-sender@example.com');
    expect(silent).toHaveBeenCalledTimes(1);
    expect(deviceCode).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
      Account: (JSON.parse(saved) as { readonly Account: unknown }).Account,
    });
  });
});
