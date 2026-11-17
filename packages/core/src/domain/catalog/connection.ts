import type { EmailAddress } from '../addressing/email-address';

export type ProviderKind = string;

export interface Connection {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly mailbox: EmailAddress;
  readonly displayName?: string;
  readonly settings?: unknown;
}
