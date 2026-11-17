import { join } from 'node:path';
import {
  type AuthProvider,
  ConfigError,
  type Connection,
  INTEGRATION_KIND,
  type IntegrationDescriptor,
  invalid,
  type PreparedSender,
  SENDER_CONTRACT,
  type SenderContext,
  valid,
  type ValidationOutcome,
} from '@mailroll/core';
import { type FetchFn, GraphClient } from './graph-client';
import { OUTLOOK_VERSION } from './version';
import { OutlookAuthProvider, type OutlookConnectionConfig } from './outlook-auth-provider';

export const OUTLOOK_INTEGRATION_ID = 'outlook';

export type OutlookSettings = Readonly<Record<string, never>>;

export interface OutlookIntegrationOptions {
  readonly fetchFn?: FetchFn;
  readonly authFor?: (config: OutlookConnectionConfig, context: SenderContext<OutlookSettings>) => AuthProvider;
}

export function createOutlookIntegration(
  options: OutlookIntegrationOptions = {},
): IntegrationDescriptor<OutlookSettings> {
  const authFor = options.authFor ?? signInWithMicrosoft;

  return {
    kind: INTEGRATION_KIND,
    id: OUTLOOK_INTEGRATION_ID,
    version: OUTLOOK_VERSION,
    displayName: 'Microsoft Outlook (Microsoft Graph)',
    configuration: {
      secrets: [
        { name: 'TENANT_ID', required: true, sensitive: false },
        { name: 'CLIENT_ID', required: true, sensitive: false },
      ],
      validateSettings: noSettings,
    },
    roles: {
      sender: {
        contract: SENDER_CONTRACT,
        capabilities: {
          cc: true,
          replyTo: true,
          inlineAttachments: true,
          sentCopy: 'optional',
          recipientAcceptance: 'transaction',
        },
        prepare: async (context: SenderContext<OutlookSettings>): Promise<PreparedSender> => {
          const connection: Connection = {
            id: context.connectionId,
            kind: OUTLOOK_INTEGRATION_ID,
            mailbox: context.from,
            ...(context.fromName === undefined ? {} : { displayName: context.fromName }),
          };
          const auth = authFor(
            {
              tenantId: requiredSecret(context, 'TENANT_ID'),
              clientId: requiredSecret(context, 'CLIENT_ID'),
              tokenCachePath: outlookTokenCachePath(context.stateDirectory, context.stateKey),
            },
            context,
          );

          await auth.getAccessToken(connection);

          const client = new GraphClient({
            getAccessToken: () => auth.getAccessToken(connection),
            ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
          });

          return {
            send: (message, _attempt, preferences) =>
              client.send(message, { saveToSentItems: preferences.keepSentCopy }),
            close: () => Promise.resolve(),
          };
        },
      },
    },
  };
}

export const outlookIntegration = createOutlookIntegration();

export function outlookTokenCachePath(stateDirectory: string, stateKey: string): string {
  return join(stateDirectory, `${stateKey}.json`);
}

function signInWithMicrosoft(config: OutlookConnectionConfig, context: SenderContext<OutlookSettings>): AuthProvider {
  return new OutlookAuthProvider(() => config, {
    announce: (message) => {
      context.interaction.announce(message);
    },
    signIn: context.interactive ? 'device-code' : 'cached-only',
    signal: context.signal,
  });
}

function noSettings(raw: unknown): ValidationOutcome<OutlookSettings> {
  return raw === undefined || (typeof raw === 'object' && raw !== null && Object.keys(raw).length === 0)
    ? valid({})
    : invalid(['outlook connections take no settings']);
}

function requiredSecret(context: SenderContext<OutlookSettings>, name: string): string {
  const value = context.secrets[name];

  if (value === undefined) {
    throw new ConfigError(`the outlook integration needs ${name} for connection "${context.connectionId}"`);
  }

  return value;
}
