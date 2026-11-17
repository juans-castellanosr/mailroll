import type { EmailAddress } from '../addressing/email-address';
import type { Pacing } from './pacing';

export type CcPolicy = 'forbidden' | 'required' | 'optional';

export interface Template {
  readonly id: string;
  readonly campaignId: string;
  readonly connectionIds: readonly string[];
  readonly ccPolicy: CcPolicy;
  readonly dir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly assetsDir: string;
  readonly compiledHtmlPath: string;
  readonly context: Readonly<Record<string, string>>;
  readonly subjectTemplate?: string;
  readonly pacing?: Pacing;
  readonly saveToSentItems?: boolean;
  readonly cc?: readonly EmailAddress[];
}

export interface ResolvedTemplate extends Template {
  readonly dataFile: string;
  readonly dataPath: string;
  readonly statePath: string;
}
