import type { LogLevel } from '../logging/console-logger';
import type { Output } from './output';

export interface CliContext {
  readonly campaignsRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly out: Output;
  readonly logLevel: LogLevel;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly loadIntegrations: (cwd: string) => Promise<readonly unknown[]>;
}

export const EXIT = {
  ok: 0,
  attention: 1,
  usage: 2,
  interrupted: 130,
} as const;
