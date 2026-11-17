import { describe, expect, it } from 'vitest';
import type { EmailAddress } from '../../src/domain/addressing/email-address';
import type { Recipient } from '../../src/domain/addressing/recipient';
import type { SourceRecord } from '../../src/domain/addressing/source-record';
import { valid } from '../../src/domain/kernel/validation-outcome';
import { collectRecipients } from '../../src/engine/collect-recipients';
import type { RecipientValidator } from '../../src/ports/recipient-validator';

const source = (records: readonly SourceRecord[]) => ({
  read: async function* () {
    await Promise.resolve();
    yield* records;
  },
});

const trusting: RecipientValidator<Recipient> = {
  validate: (record) => valid({ email: record['email'] as unknown as EmailAddress }),
};

describe('collectRecipients', () => {
  it('normalizes the email a template validator returns before using it', async () => {
    const { valid: accepted } = await collectRecipients(source([{ email: '  élise@example.com ' }]), trusting);

    expect(accepted.map((r) => r.email)).toEqual(['élise@example.com']);
  });

  it('skips a row whose validator returned something that is not a valid email, without throwing', async () => {
    const numeric: RecipientValidator<Recipient> = {
      validate: () => valid({ email: 42 as unknown as EmailAddress }),
    };

    const { valid: accepted, skips } = await collectRecipients(source([{ email: 'x' }]), numeric);

    expect(accepted).toEqual([]);
    expect(skips).toEqual([
      {
        status: 'skipped',
        identifier: 'row 1',
        reasons: ['the template validator returned an invalid email: email must be text'],
      },
    ]);
  });

  it('still deduplicates case-insensitively on the normalized address', async () => {
    const { valid: accepted, skips } = await collectRecipients(
      source([{ email: 'Ada@Example.com' }, { email: ' ada@example.com' }]),
      trusting,
    );

    expect(accepted.map((r) => r.email)).toEqual(['Ada@Example.com']);
    expect(skips.map((s) => s.reasons)).toEqual([['duplicate email in source (kept the first occurrence)']]);
  });
});
