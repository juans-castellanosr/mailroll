import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AccountInfo, InteractionRequiredAuthError, PublicClientApplication } from '@azure/msal-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, type Connection, type EmailAddress, parseEmailAddress, SignInRequiredError } from '@mailroll/core';
import { OutlookAuthProvider, type SignInMode } from '../src/outlook-auth-provider';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

const CONNECTION: Connection = { id: 'outlook-1', kind: 'outlook', mailbox: addr('Sender@Org.co') };
const account = (username: string): AccountInfo => ({
  homeAccountId: username,
  environment: 'e',
  tenantId: 't',
  username,
  localAccountId: username,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-auth-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function provider(signIn: SignInMode = 'device-code'): OutlookAuthProvider {
  return new OutlookAuthProvider(
    () => ({
      tenantId: 'tenant',
      clientId: '00000000-0000-0000-0000-000000000000',
      tokenCachePath: join(dir, 'cache.json'),
    }),
    { announce: () => undefined, signIn },
  );
}

function stubCache(accounts: readonly AccountInfo[]): void {
  vi.spyOn(PublicClientApplication.prototype, 'getTokenCache').mockReturnValue({
    getAllAccounts: () => Promise.resolve([...accounts]),
  } as unknown as ReturnType<PublicClientApplication['getTokenCache']>);
}

describe('OutlookAuthProvider', () => {
  it('uses only the cached account that matches the connection mailbox (case-insensitive)', async () => {
    stubCache([account('someone.else@other.co'), account('sender@org.co')]);
    const silent = vi
      .spyOn(PublicClientApplication.prototype, 'acquireTokenSilent')
      .mockImplementation((request) => Promise.resolve({ accessToken: `T-${request.account.username}` } as never));

    expect(await provider().getAccessToken(CONNECTION)).toBe('T-sender@org.co');
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it('never uses a cached account of another mailbox; falls back to sign-in', async () => {
    stubCache([account('someone.else@other.co')]);
    const silent = vi.spyOn(PublicClientApplication.prototype, 'acquireTokenSilent');

    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode').mockResolvedValue({
      accessToken: 'DEVICE',
      account: account('SENDER@org.co'),
    } as never);
    expect(await provider().getAccessToken(CONNECTION)).toBe('DEVICE');
    expect(silent).not.toHaveBeenCalled();
  });

  it('refuses a device-code sign-in completed with a different account', async () => {
    stubCache([]);
    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode').mockResolvedValue({
      accessToken: 'DEVICE',
      account: account('someone.else@other.co'),
    } as never);

    const error = await provider()
      .getAccessToken(CONNECTION)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as Error).message).toMatch(/signed in as someone\.else@other\.co.*sends as Sender@Org\.co/);
  });

  it('still offers a sign-in when the cache cannot be read', async () => {
    vi.spyOn(PublicClientApplication.prototype, 'getTokenCache').mockReturnValue({
      getAllAccounts: () => Promise.reject(new SyntaxError('Unterminated string in JSON')),
    } as unknown as ReturnType<PublicClientApplication['getTokenCache']>);
    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode').mockResolvedValue({
      accessToken: 'DEVICE',
      account: account('sender@org.co'),
    } as never);
    expect(await provider().getAccessToken(CONNECTION)).toBe('DEVICE');
  });

  it('never starts a device-code sign-in in cached-only mode', async () => {
    stubCache([]);
    const device = vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode');

    await expect(provider('cached-only').getAccessToken(CONNECTION)).rejects.toBeInstanceOf(SignInRequiredError);
    expect(device).not.toHaveBeenCalled();
  });

  it('falls back to device code only when Microsoft asks for interaction', async () => {
    stubCache([account('sender@org.co')]);
    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenSilent').mockRejectedValue(
      new InteractionRequiredAuthError('interaction_required', 'test-correlation-id'),
    );
    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode').mockResolvedValue({
      accessToken: 'DEVICE',
      account: account('sender@org.co'),
    } as never);

    expect(await provider().getAccessToken(CONNECTION)).toBe('DEVICE');
  });

  it('reports any other silent sign-in failure instead of prompting again', async () => {
    stubCache([account('sender@org.co')]);
    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenSilent').mockRejectedValue(new Error('network down'));
    const device = vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode');

    await expect(provider().getAccessToken(CONNECTION)).rejects.toBeInstanceOf(AuthError);
    expect(device).not.toHaveBeenCalled();
  });

  it('stops polling for a device-code sign-in when the run is aborted', async () => {
    stubCache([]);
    const controller = new AbortController();
    let canceledRequest = false;

    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenByDeviceCode').mockImplementation(async (request) => {
      controller.abort();
      await Promise.resolve();
      canceledRequest = request.cancel === true;
      throw new Error('polling stopped');
    });
    const auth = new OutlookAuthProvider(
      () => ({ tenantId: 't', clientId: '00000000-0000-0000-0000-000000000000', tokenCachePath: join(dir, 'c.json') }),
      { announce: () => undefined, signal: controller.signal },
    );

    await expect(auth.getAccessToken(CONNECTION)).rejects.toThrow(/was canceled/);
    expect(canceledRequest).toBe(true);
  });

  it('tells an expired saved sign-in apart from a missing one in cached-only mode', async () => {
    stubCache([account('sender@org.co')]);
    vi.spyOn(PublicClientApplication.prototype, 'acquireTokenSilent').mockRejectedValue(
      new InteractionRequiredAuthError('interaction_required', 'test-correlation-id'),
    );

    await expect(provider('cached-only').getAccessToken(CONNECTION)).rejects.toThrow(/the saved sign-in has expired/);
  });
});
