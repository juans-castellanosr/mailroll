import { ConfigError, type SecretDeclaration } from '@mailroll/core';
import { safeSegment } from './connection-key';

export function connectionEnvKey(campaignId: string, connectionId: string, field: string): string {
  return `${safeSegment(campaignId).toUpperCase()}__${safeSegment(connectionId).toUpperCase()}__${field}`;
}

export function resolveDeclaredSecrets(
  campaignId: string,
  connectionId: string,
  declarations: readonly SecretDeclaration[],
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const declaration of declarations) {
    const key = connectionEnvKey(campaignId, connectionId, declaration.name);
    const value = env[key]?.trim() ?? '';

    if (value.length > 0) {
      secrets[declaration.name] = value;
    } else if (declaration.required) {
      throw new ConfigError(`missing environment secret ${key}`);
    }
  }

  return secrets;
}
