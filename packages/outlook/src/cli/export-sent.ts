import { open, rm } from 'node:fs/promises';
import { type AuthProvider, ConfigError } from '@mailroll/core';
import type { FetchFn } from '../graph-client';
import { OutlookAuthProvider, type OutlookConnectionConfig } from '../outlook-auth-provider';
import { OUTLOOK_INTEGRATION_ID, outlookIntegration, outlookTokenCachePath } from '../outlook-integration';
import { SentItemsReader } from '../sent-items-reader';
import type { CliOutput } from './cli-output';
import type { MailrollHost } from './host';

export class CliError extends Error {}

export interface ExportSentContext {
  readonly campaignsRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly out: CliOutput;
  readonly interactive: boolean;
  readonly host: MailrollHost;
  readonly fetchFn?: FetchFn;
  readonly authFor?: (config: OutlookConnectionConfig) => AuthProvider;
}

export interface ExportSentOptions {
  readonly campaign: string;
  readonly connection: string;
  readonly since: string;
  readonly out: string;
}

function resolveSecrets(
  ctx: ExportSentContext,
  campaignId: string,
  connectionId: string,
): Readonly<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const declaration of outlookIntegration.configuration.secrets) {
    const key = ctx.host.connectionEnvKey(campaignId, connectionId, declaration.name);
    const value = ctx.env[key]?.trim() ?? '';

    if (value.length > 0) {
      secrets[declaration.name] = value;
    } else if (declaration.required) {
      throw new ConfigError(`missing environment secret ${key}`);
    }
  }

  return secrets;
}

export async function exportSentCommand(ctx: ExportSentContext, options: ExportSentOptions): Promise<void> {
  const since = new Date(`${options.since}T00:00:00Z`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.since) || Number.isNaN(since.getTime())) {
    throw new CliError(`invalid --since date "${options.since}" (expected YYYY-MM-DD)`);
  }

  const campaign = (await ctx.host.discoverCampaigns(ctx.campaignsRoot)).find((c) => c.id === options.campaign);

  if (campaign === undefined) {
    throw new CliError(`campaign "${options.campaign}" not found under ${ctx.campaignsRoot}`);
  }

  const connection = campaign.connections.find((c) => c.id === options.connection);

  if (connection === undefined) {
    throw new CliError(`connection "${options.connection}" not found in campaign "${campaign.id}"`);
  }

  if (connection.kind !== OUTLOOK_INTEGRATION_ID) {
    throw new CliError(
      `export-sent reads Outlook Sent Items, and connection "${connection.id}" uses the "${connection.kind}" integration`,
    );
  }

  const secrets = resolveSecrets(ctx, campaign.id, connection.id);
  const tenantId = secrets['TENANT_ID'];
  const clientId = secrets['CLIENT_ID'];

  if (tenantId === undefined || clientId === undefined) {
    throw new ConfigError(`connection "${connection.id}" is missing its Outlook tenant or client id`);
  }

  const location = ctx.host.connectionStateLocation({
    env: ctx.env,
    campaignId: campaign.id,
    connectionId: connection.id,
  });
  const config: OutlookConnectionConfig = {
    tenantId,
    clientId,
    tokenCachePath: outlookTokenCachePath(location.stateDirectory, location.stateKey),
  };
  const auth =
    ctx.authFor?.(config) ??
    new OutlookAuthProvider(() => config, {
      announce: (message) => {
        ctx.out.info(message);
      },
      scopes: ['Mail.ReadBasic'],
      signIn: ctx.interactive ? 'device-code' : 'cached-only',
    });
  const messages = await new SentItemsReader({
    getAccessToken: () => auth.getAccessToken(connection),
    ...(ctx.fetchFn === undefined ? {} : { fetchFn: ctx.fetchFn }),
  }).listSince(since);
  const payload = {
    exportedAt: new Date().toISOString(),
    campaignId: campaign.id,
    connectionId: connection.id,
    mailbox: connection.mailbox,
    since: since.toISOString(),
    count: messages.length,
    messages,
  };
  const handle = await open(options.out, 'wx', 0o600).catch((error: unknown) => {
    throw new CliError(`cannot create ${options.out} (it must not exist yet)`, { cause: error });
  });

  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(options.out, { force: true });

    throw new Error(`cannot write ${options.out}; nothing was kept`, { cause: error });
  }

  await handle.close();

  ctx.out.info(`exported ${String(messages.length)} Sent Items message(s) to ${options.out}`);
}
