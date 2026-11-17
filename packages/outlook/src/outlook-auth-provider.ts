import {
  type AccountInfo,
  type Configuration,
  type DeviceCodeRequest,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-node';
import { AuthError, type AuthProvider, type Connection, SignInRequiredError } from '@mailroll/core';
import { createFileTokenCachePlugin } from './token-cache-plugin';

export interface OutlookConnectionConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly tokenCachePath: string;
}

export type OutlookConfigResolver = (connection: Connection) => OutlookConnectionConfig;

export type SignInMode = 'device-code' | 'cached-only';

export interface OutlookAuthOptions {
  readonly announce?: (message: string) => void;
  readonly scopes?: readonly string[];
  readonly signIn?: SignInMode;
  readonly signal?: AbortSignal;
}

const DEFAULT_SCOPES: readonly string[] = ['Mail.Send'];

type SilentOutcome =
  { readonly kind: 'token'; readonly token: string } | { readonly kind: 'missing' } | { readonly kind: 'expired' };

export class OutlookAuthProvider implements AuthProvider {
  private readonly apps = new Map<string, PublicClientApplication>();
  private readonly announce: (message: string) => void;
  private readonly scopes: readonly string[];
  private readonly signIn: SignInMode;
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly resolveConfig: OutlookConfigResolver,
    options: OutlookAuthOptions = {},
  ) {
    this.announce = options.announce ?? ((message) => process.stderr.write(`${message}\n`));
    this.scopes = options.scopes ?? DEFAULT_SCOPES;
    this.signIn = options.signIn ?? 'device-code';
    this.signal = options.signal;
  }

  async getAccessToken(connection: Connection): Promise<string> {
    const app = this.appFor(connection);
    const silent = await this.tryAcquireSilent(app, connection);

    if (silent.kind === 'token') {
      return silent.token;
    }

    if (this.signIn === 'cached-only') {
      const state = silent.kind === 'expired' ? 'the saved sign-in has expired' : 'no saved sign-in';

      throw new SignInRequiredError(
        `${state} for ${connection.mailbox} (connection "${connection.id}"); run mailroll once in a terminal to sign in`,
      );
    }

    return this.acquireByDeviceCode(app, connection);
  }

  private appFor(connection: Connection): PublicClientApplication {
    const existing = this.apps.get(connection.id);

    if (existing !== undefined) {
      return existing;
    }

    const cfg = this.resolveConfig(connection);
    const configuration: Configuration = {
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      },
      cache: { cachePlugin: createFileTokenCachePlugin(cfg.tokenCachePath, this.announce) },
    };
    const app = new PublicClientApplication(configuration);

    this.apps.set(connection.id, app);

    return app;
  }

  private async tryAcquireSilent(app: PublicClientApplication, connection: Connection): Promise<SilentOutcome> {
    let accounts: AccountInfo[];

    try {
      accounts = await app.getTokenCache().getAllAccounts();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';

      this.announce(`The saved sign-in of connection "${connection.id}" cannot be read (${detail}); sign in again.`);

      return { kind: 'missing' };
    }

    const account = accounts.find((a) => sameMailbox(a.username, connection.mailbox));

    if (account === undefined) {
      return { kind: 'missing' };
    }

    try {
      const result = await app.acquireTokenSilent({ account, scopes: [...this.scopes] });

      return { kind: 'token', token: result.accessToken };
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        return { kind: 'expired' };
      }

      throw new AuthError(`could not refresh the sign-in of connection "${connection.id}"`, { cause: error });
    }
  }

  private canceled(): boolean {
    return this.signal?.aborted === true;
  }

  private async acquireByDeviceCode(app: PublicClientApplication, connection: Connection): Promise<string> {
    const request: DeviceCodeRequest = {
      scopes: [...this.scopes],
      deviceCodeCallback: (response) => {
        this.announce(`Sign in as ${connection.mailbox} (connection "${connection.id}"). ${response.message}`);
      },
    };

    if (this.canceled()) {
      throw new AuthError(`sign-in for connection "${connection.id}" was canceled`);
    }

    let result: Awaited<ReturnType<PublicClientApplication['acquireTokenByDeviceCode']>>;
    const cancel = (): void => {
      request.cancel = true;
    };

    this.signal?.addEventListener('abort', cancel, { once: true });

    try {
      result = await app.acquireTokenByDeviceCode(request);
    } catch (error) {
      if (this.canceled()) {
        throw new AuthError(`sign-in for connection "${connection.id}" was canceled`, { cause: error });
      }

      throw error;
    } finally {
      this.signal?.removeEventListener('abort', cancel);
    }

    if (result === null || result.accessToken.length === 0) {
      throw new AuthError('device-code authentication did not return an access token');
    }

    const signedIn = result.account?.username ?? '(unknown account)';

    if (!sameMailbox(signedIn, connection.mailbox)) {
      throw new AuthError(
        `signed in as ${signedIn}, but connection "${connection.id}" sends as ${connection.mailbox}; sign in with that mailbox`,
      );
    }

    return result.accessToken;
  }
}

function sameMailbox(username: string, mailbox: string): boolean {
  return username.trim().toLowerCase() === mailbox.trim().toLowerCase();
}
