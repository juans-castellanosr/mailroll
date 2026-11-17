import { type EmailAddress, parseEmailAddress } from './email-address';
import { ConfigError } from '../kernel/errors';

export function requireEmailAddress(value: unknown, field: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new ConfigError(`${field}: ${outcome.reasons.join('; ')}`);
  }

  return outcome.value;
}

export function requireEmailAddresses(values: unknown, field: string): readonly EmailAddress[] {
  if (!Array.isArray(values)) {
    throw new ConfigError(`${field}: expected a list of email addresses`);
  }

  return values.map((value: unknown, index) => requireEmailAddress(value, `${field}.${String(index)}`));
}
