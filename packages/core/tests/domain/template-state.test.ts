import { describe, expect, it } from 'vitest';
import { type RecipientStatus, settleStatus } from '../../src/domain/run/template-state';

const sent: RecipientStatus = { status: 'sent', at: 'T0', connectionId: 'x' };
const uncertain: RecipientStatus = { status: 'uncertain', at: 'T0', connectionId: 'x', message: 'timeout' };
const failed: RecipientStatus = {
  status: 'failed',
  at: 'T1',
  connectionId: 'x',
  category: 'permanent',
  message: 'rejected',
};

describe('settleStatus', () => {
  it('never downgrades a sent recipient (D-2)', () => {
    expect(settleStatus(sent, failed)).toEqual({
      ...sent,
      resendFailure: { at: 'T1', connectionId: 'x', outcome: 'failed', message: 'rejected', category: 'permanent' },
    });
  });

  it('keeps an uncertain recipient uncertain when a deliberate resend fails (D-1)', () => {
    expect(settleStatus(uncertain, failed)).toMatchObject({
      status: 'uncertain',
      at: 'T0',
      resendFailure: { outcome: 'failed' },
    });
  });

  it('lets a confirmed send settle anything, and a failure replace a failure', () => {
    expect(settleStatus(uncertain, { ...sent, at: 'T2' })).toEqual({ ...sent, at: 'T2' });
    expect(settleStatus(failed, { ...failed, at: 'T3' })).toEqual({ ...failed, at: 'T3' });
    expect(settleStatus(undefined, failed)).toEqual(failed);
  });
});

describe('settleStatus, every previous status against every outcome (status rules, including the two that drop the earlier record)', () => {
  const olderFailure = {
    at: 'T1',
    connectionId: 'x',
    outcome: 'failed',
    message: 'old',
    category: 'transient',
  } as const;
  const previous = {
    nothing: undefined,
    sent,
    'sent with a resend failure': { ...sent, resendFailure: olderFailure },
    failed,
    uncertain,
    'uncertain with a resend failure': { ...uncertain, resendFailure: olderFailure },
  } satisfies Record<string, RecipientStatus | undefined>;
  const next = {
    sent: { status: 'sent', at: 'T9', connectionId: 'y' },
    failed: { status: 'failed', at: 'T9', connectionId: 'y', category: 'permanent', message: 'no' },
    uncertain: { status: 'uncertain', at: 'T9', connectionId: 'y', message: 'lost' },
  } satisfies Record<string, RecipientStatus>;
  const asFailure = {
    failed: { at: 'T9', connectionId: 'y', outcome: 'failed', message: 'no', category: 'permanent' },
    uncertain: { at: 'T9', connectionId: 'y', outcome: 'uncertain', message: 'lost' },
  } as const;

  it.each([
    ['nothing', 'sent', next.sent],
    ['nothing', 'failed', next.failed],
    ['nothing', 'uncertain', next.uncertain],
    ['sent', 'sent', next.sent],
    ['sent', 'failed', { ...sent, resendFailure: asFailure.failed }],
    ['sent', 'uncertain', { ...sent, resendFailure: asFailure.uncertain }],
    ['sent with a resend failure', 'sent', next.sent],
    ['sent with a resend failure', 'failed', { ...sent, resendFailure: asFailure.failed }],
    ['sent with a resend failure', 'uncertain', { ...sent, resendFailure: asFailure.uncertain }],
    ['failed', 'sent', next.sent],
    ['failed', 'failed', next.failed],
    ['failed', 'uncertain', next.uncertain],
    ['uncertain', 'sent', next.sent],
    ['uncertain', 'failed', { ...uncertain, resendFailure: asFailure.failed }],
    ['uncertain', 'uncertain', next.uncertain],
    ['uncertain with a resend failure', 'sent', next.sent],
    ['uncertain with a resend failure', 'failed', { ...uncertain, resendFailure: asFailure.failed }],
    ['uncertain with a resend failure', 'uncertain', next.uncertain],
  ] as const)('%s, then %s', (before, outcome, expected) => {
    expect(settleStatus(previous[before], next[outcome])).toEqual(expected);
  });
});
