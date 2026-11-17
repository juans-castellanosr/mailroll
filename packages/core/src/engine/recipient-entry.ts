import { normalizeEmail } from '../domain/addressing/email-address';
import { optionalField } from '../domain/kernel/optional-field';
import type { SendResult } from '../domain/run/send-result';
import type { RecipientStatus } from '../domain/run/template-state';

export function recipientEntry(result: SendResult): readonly [string, RecipientStatus] | undefined {
  switch (result.status) {
    case 'skipped':
    case 'not-attempted':
      return undefined;
    case 'sent':
      return [
        normalizeEmail(result.recipient),
        {
          status: 'sent',
          at: result.at,
          connectionId: result.connectionId,
          ...optionalField('attemptId', result.attemptId),
          ...optionalField('providerMessageId', result.providerMessageId),
          ...optionalField('cc', result.cc),
        },
      ];
    case 'failed':
      return [
        normalizeEmail(result.recipient),
        {
          status: 'failed',
          at: result.at,
          connectionId: result.connectionId,
          category: result.category,
          message: result.message,
          ...optionalField('attemptId', result.attemptId),
        },
      ];
    case 'uncertain':
      return [
        normalizeEmail(result.recipient),
        {
          status: 'uncertain',
          at: result.at,
          connectionId: result.connectionId,
          message: result.message,
          ...optionalField('attemptId', result.attemptId),
        },
      ];
  }
}
