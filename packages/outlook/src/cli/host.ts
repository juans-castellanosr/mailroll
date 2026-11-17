import { createRequire } from 'node:module';
import type * as Mailroll from 'mailroll';

export type MailrollHost = Pick<typeof Mailroll, 'connectionEnvKey' | 'connectionStateLocation' | 'discoverCampaigns'>;

const REQUIRED_CAPABILITIES = ['connectionEnvKey', 'connectionStateLocation', 'discoverCampaigns'] as const;

export class MissingHostError extends Error {}

export async function loadInstalledMailroll(): Promise<unknown> {
  try {
    createRequire(import.meta.url).resolve('mailroll/package.json');
  } catch (error) {
    throw new MissingHostError('mailroll cannot be resolved from @mailroll/outlook', { cause: error });
  }

  return import('mailroll');
}

export function isMailrollHost(module: unknown): module is MailrollHost {
  return (
    typeof module === 'object' &&
    module !== null &&
    REQUIRED_CAPABILITIES.every((name) => typeof Reflect.get(module, name) === 'function')
  );
}
