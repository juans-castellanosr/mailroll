import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import { recipientEntry } from '../../src/engine/recipient-entry';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

describe('recipientEntry', () => {
  it('maps a sent result to its normalized key and status', () => {
    const entry = recipientEntry({
      status: 'sent',
      recipient: addr('A@X.co'),
      connectionId: 'x',
      at: 'T',
    });

    expect(entry).toEqual(['a@x.co', { status: 'sent', at: 'T', connectionId: 'x' }]);
  });

  it('maps a failed result carrying its category and message', () => {
    const entry = recipientEntry({
      status: 'failed',
      recipient: addr('a@x.co'),
      connectionId: 'x',
      at: 'T',
      category: 'permanent',
      message: 'boom',
    });

    expect(entry).toEqual([
      'a@x.co',
      { status: 'failed', at: 'T', connectionId: 'x', category: 'permanent', message: 'boom' },
    ]);
  });

  it('returns undefined for a skipped result (nothing to persist)', () => {
    expect(recipientEntry({ status: 'skipped', identifier: 'a@x.co', reasons: ['already sent'] })).toBeUndefined();
  });
});
