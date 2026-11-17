import { type EmailAddress, normalizeEmail, parseEmailAddress } from '../domain/addressing/email-address';
import type { Recipient } from '../domain/addressing/recipient';
import { EMAIL_FIELD } from '../domain/addressing/source-record';
import type { SkippedResult } from '../domain/run/send-result';
import type { DataSource } from '../ports/data-source';
import type { RecipientValidator } from '../ports/recipient-validator';

export interface ValidRecipient<T> {
  readonly email: EmailAddress;
  readonly recipient: T;
}

export interface CollectedRecipients<T> {
  readonly valid: readonly ValidRecipient<T>[];
  readonly skips: readonly SkippedResult[];
}

export async function collectRecipients<T extends Recipient>(
  source: DataSource,
  validator: RecipientValidator<T>,
): Promise<CollectedRecipients<T>> {
  const valid: ValidRecipient<T>[] = [];
  const skips: SkippedResult[] = [];
  const seen = new Set<string>();
  let row = 0;

  for await (const record of source.read()) {
    row += 1;
    const outcome = validator.validate(record);

    if (!outcome.ok) {
      const raw = record[EMAIL_FIELD]?.trim();
      const identifier = raw !== undefined && raw.length > 0 ? raw : `row ${String(row)}`;

      skips.push({ status: 'skipped', identifier, reasons: outcome.reasons });
      continue;
    }

    const email = parseEmailAddress(outcome.value.email);

    if (!email.ok) {
      skips.push({
        status: 'skipped',
        identifier: `row ${String(row)}`,
        reasons: email.reasons.map((reason) => `the template validator returned an invalid email: ${reason}`),
      });
      continue;
    }

    const key = normalizeEmail(email.value);

    if (seen.has(key)) {
      skips.push({
        status: 'skipped',
        identifier: email.value,
        reasons: ['duplicate email in source (kept the first occurrence)'],
      });
      continue;
    }

    seen.add(key);
    valid.push({ email: email.value, recipient: outcome.value });
  }

  return { valid, skips };
}
