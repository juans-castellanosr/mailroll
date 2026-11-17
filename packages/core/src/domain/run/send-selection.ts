import type { EmailAddress } from '../addressing/email-address';
import type { RunMode } from './run-mode';

export type ResendPolicy =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed-only' }
  | { readonly kind: 'force-all' }
  | { readonly kind: 'subset'; readonly recipients: readonly EmailAddress[] };

export interface TemplateTarget {
  readonly templateId: string;
  readonly dataFile?: string;
  readonly policy?: ResendPolicy;
  readonly cc?: readonly EmailAddress[];
  readonly dataFingerprint?: string;
}

export interface SendSelection {
  readonly campaignId: string;
  readonly targets: readonly TemplateTarget[];
  readonly connectionIds: readonly string[];
  readonly policy: ResendPolicy;
  readonly mode: RunMode;
  readonly cc?: readonly EmailAddress[];
}
