import { join } from 'node:path';
import { safeSegment } from './connection-key';

const DEFAULT_STATE_ROOT = '.secrets/tokens';

export interface ConnectionStateLocation {
  readonly stateDirectory: string;
  readonly stateKey: string;
}

export interface ConnectionStateLocationOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly campaignId: string;
  readonly connectionId: string;
}

function campaignStateDirectory(env: NodeJS.ProcessEnv, campaignId: string): string {
  return join(env['TOKEN_CACHE_PATH'] ?? DEFAULT_STATE_ROOT, safeSegment(campaignId));
}

function connectionStateKey(connectionId: string): string {
  return safeSegment(connectionId);
}

export function connectionStateLocation(options: ConnectionStateLocationOptions): ConnectionStateLocation {
  return {
    stateDirectory: campaignStateDirectory(options.env, options.campaignId),
    stateKey: connectionStateKey(options.connectionId),
  };
}
