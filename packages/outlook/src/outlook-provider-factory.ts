import type {
  AuthProvider,
  Connection,
  EmailProvider,
  EmailProviderFactory,
  EmailProviderOptions,
} from '@mailroll/core';
import { OutlookProvider } from './outlook-provider';

export class OutlookProviderFactory implements EmailProviderFactory {
  readonly kind = 'outlook' as const;

  create(connection: Connection, auth: AuthProvider, options: EmailProviderOptions): EmailProvider {
    return new OutlookProvider(connection, auth, { saveToSentItems: options.saveToSentItems });
  }
}
