import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import type { SendResult } from '../../src/domain/run/send-result';
import { needsAttention, report } from '../../src/engine/report';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

describe('report', () => {
  it('counts each outcome kind', () => {
    const results: SendResult[] = [
      { status: 'sent', recipient: addr('a@x.co'), connectionId: 'x', at: 'T' },
      { status: 'sent', recipient: addr('b@x.co'), connectionId: 'x', at: 'T' },
      { status: 'failed', recipient: addr('c@x.co'), connectionId: 'x', at: 'T', category: 'permanent', message: 'm' },
      { status: 'skipped', identifier: 'd', reasons: ['invalid'] },
    ];

    expect(report(results)).toMatchObject({ total: 4, sent: 2, failed: 1, skipped: 1 });
  });

  it('handles an empty run', () => {
    expect(report([])).toMatchObject({ total: 0, sent: 0, failed: 0, skipped: 0 });
  });
});

describe('report: rejected CC', () => {
  const sentWith = (email: string, cc?: { rejected: string[]; required: boolean }): SendResult => ({
    status: 'sent',
    recipient: addr(email),
    connectionId: 'x',
    at: 'T',
    ...(cc === undefined ? {} : { cc }),
  });

  it('counts messages with a rejected CC, never the rejected addresses', () => {
    const summary = report([
      sentWith('a@x.co', { rejected: ['c1@x.co', 'c2@x.co', 'c3@x.co'], required: true }),
      sentWith('b@x.co', { rejected: ['c1@x.co'], required: false }),
      sentWith('c@x.co', { rejected: [], required: true }),
      sentWith('d@x.co'),
    ]);

    expect(summary).toMatchObject({ sent: 4, ccRejectedMessages: 2, requiredCcRejectedMessages: 1 });
  });

  it.each([
    ['no CC observed', undefined, false],
    ['every CC accepted', { rejected: [], required: true }, false],
    ['an optional CC rejected', { rejected: ['c@x.co'], required: false }, false],
    ['a required CC rejected', { rejected: ['c@x.co'], required: true }, true],
  ])('needs attention for %s: %s', (_label, cc, expected) => {
    expect(needsAttention(report([sentWith('a@x.co', cc)]))).toBe(expected);
  });

  const others: readonly (readonly [string, SendResult])[] = [
    [
      'failed',
      { status: 'failed', recipient: addr('z@x.co'), connectionId: 'x', at: 'T', category: 'permanent', message: 'm' },
    ],
    ['uncertain', { status: 'uncertain', recipient: addr('z@x.co'), connectionId: 'x', at: 'T', message: 'm' }],
    ['not-attempted', { status: 'not-attempted', recipient: addr('z@x.co'), reason: 'stopped' }],
    ['held-uncertain', { status: 'skipped', identifier: 'z@x.co', reasons: ['held'], code: 'held-uncertain' }],
  ];

  it.each(others)('an optional rejected CC never hides a %s recipient', (_label, other) => {
    expect(needsAttention(report([sentWith('a@x.co', { rejected: ['c@x.co'], required: false }), other]))).toBe(true);
  });
});
