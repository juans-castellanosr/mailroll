import type { EmailAddress } from '../addressing/email-address';

export type RunMode =
  | { readonly kind: 'live' }
  | { readonly kind: 'test'; readonly testRecipient: EmailAddress }
  | { readonly kind: 'dry-run' };
