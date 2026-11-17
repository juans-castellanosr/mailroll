import { type CcPolicy, ConfigError, type EmailAddress, type RunMode } from '@mailroll/core';

export function resolveCc(
  policy: CcPolicy,
  cc: readonly EmailAddress[] | undefined,
  mode: RunMode,
  templateId: string,
): readonly EmailAddress[] {
  const addresses = cc ?? [];

  if (policy === 'forbidden') {
    if (addresses.length > 0) {
      throw new ConfigError(
        `template "${templateId}" does not allow CC (it would expose one recipient's message to a third party)`,
      );
    }

    return [];
  }

  if (policy === 'required' && mode.kind === 'live' && addresses.length === 0) {
    throw new ConfigError(
      `template "${templateId}" requires at least one CC for a live send — pass --cc <email[,email,...]> (or set CC_RECIPIENT and choose interactively)`,
    );
  }

  return addresses;
}
