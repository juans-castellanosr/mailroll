import type { Connection, ProviderKind } from '../domain/catalog/connection';
import type { AuthProvider } from './auth-provider';
import type { EmailProvider } from './email-provider';

export interface EmailProviderOptions {
  readonly saveToSentItems: boolean;
}

export interface EmailProviderFactory {
  readonly kind: ProviderKind;
  create(connection: Connection, auth: AuthProvider, options: EmailProviderOptions): EmailProvider;
}
