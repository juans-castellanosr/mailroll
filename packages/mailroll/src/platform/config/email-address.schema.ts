import { z } from 'zod';
import { type EmailAddress, parseEmailAddress } from '@mailroll/core';

export const emailAddressSchema = z.unknown().transform((value, context): EmailAddress => {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    for (const reason of outcome.reasons) {
      context.addIssue({ code: 'custom', message: reason });
    }

    return z.NEVER;
  }

  return outcome.value;
});
