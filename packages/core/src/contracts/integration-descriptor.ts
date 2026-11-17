import type { SenderRole } from './sender';
import type { ValidationOutcome } from '../domain/kernel/validation-outcome';

export const INTEGRATION_KIND = 'mailroll.integration';

export interface SecretDeclaration {
  readonly name: string;
  readonly required: boolean;
  readonly sensitive: boolean;
}

export interface IntegrationConfiguration<Settings> {
  readonly secrets: readonly SecretDeclaration[];
  validateSettings(raw: unknown): ValidationOutcome<Settings>;
}

export interface IntegrationRoles<Settings> {
  readonly sender: SenderRole<Settings>;
}

export interface IntegrationDescriptor<Settings = unknown> {
  readonly kind: typeof INTEGRATION_KIND;
  readonly id: string;
  readonly version: string;
  readonly displayName?: string;
  readonly documentationUrl?: string;
  readonly configuration: IntegrationConfiguration<Settings>;
  readonly roles: IntegrationRoles<Settings>;
}
