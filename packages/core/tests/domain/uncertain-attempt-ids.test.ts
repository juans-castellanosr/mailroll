import { describe, expect, it } from 'vitest';
import { type RecipientStatus, settleStatus } from '../../src/domain/run/template-state';

const sent = (attemptId?: string): RecipientStatus => ({
  status: 'sent',
  at: 'T',
  connectionId: 'x',
  ...(attemptId === undefined ? {} : { attemptId }),
});
const failed = (attemptId?: string): RecipientStatus => ({
  status: 'failed',
  at: 'T',
  connectionId: 'x',
  category: 'permanent',
  message: 'rejected',
  ...(attemptId === undefined ? {} : { attemptId }),
});
const uncertain = (attemptId?: string): RecipientStatus => ({
  status: 'uncertain',
  at: 'T',
  connectionId: 'x',
  message: 'timeout',
  ...(attemptId === undefined ? {} : { attemptId }),
});
const withResend = (status: RecipientStatus, outcome: RecipientStatus): RecipientStatus =>
  settleStatus(status, outcome);

function settleStatusV1(previous: RecipientStatus | undefined, next: RecipientStatus): RecipientStatus {
  if (previous === undefined || previous.status === 'failed' || next.status === 'sent') {
    return next;
  }

  if (previous.status === 'uncertain' && next.status === 'uncertain') {
    return next;
  }

  return {
    ...previous,
    resendFailure: {
      at: next.at,
      connectionId: next.connectionId,
      outcome: next.status,
      message: next.message,
      ...(next.status === 'failed' ? { category: next.category } : {}),
    },
  };
}

const historyOf = (status: RecipientStatus): readonly string[] | undefined => status.uncertainAttemptIds;

const PREVIOUS: readonly (readonly [string, RecipientStatus | undefined])[] = [
  ['nothing', undefined],
  ['S(A)', sent('A')],
  ['S(A), rf U(B)', withResend(sent('A'), uncertain('B'))],
  ['S(A), rf F(B)', withResend(sent('A'), failed('B'))],
  ['F(A)', failed('A')],
  ['U(A)', uncertain('A')],
  ['U(A), rf F(B)', withResend(uncertain('A'), failed('B'))],
  ['U(A) [Z]', { ...uncertain('A'), uncertainAttemptIds: ['Z'] }],
  ['U without id (v1)', uncertain()],
];

const EXPECTED_HISTORY: Readonly<Record<string, readonly [unknown, unknown, unknown]>> = {
  nothing: [undefined, undefined, undefined],
  'S(A)': [undefined, undefined, undefined],
  'S(A), rf U(B)': [['B'], ['B'], ['B']],
  'S(A), rf F(B)': [undefined, undefined, undefined],
  'F(A)': [undefined, undefined, undefined],
  'U(A)': [['A'], undefined, ['A']],
  'U(A), rf F(B)': [['A'], undefined, ['A']],
  'U(A) [Z]': [['Z', 'A'], ['Z'], ['Z', 'A']],
  'U without id (v1)': [undefined, undefined, undefined],
};

describe('uncertainAttemptIds (D6)', () => {
  it.each(PREVIOUS)('keeps every earlier uncertain attempt not shown elsewhere: %s', (label, previous) => {
    const [afterSent, afterFailed, afterUncertain] = EXPECTED_HISTORY[label] ?? [];

    expect(historyOf(settleStatus(previous, sent('C')))).toEqual(afterSent);
    expect(historyOf(settleStatus(previous, failed('C')))).toEqual(afterFailed);
    expect(historyOf(settleStatus(previous, uncertain('C')))).toEqual(afterUncertain);
  });

  it.each(PREVIOUS)('decides the status exactly as the v1 rule does, whatever the ids: %s', (_label, previous) => {
    const strip = (status: RecipientStatus | undefined): unknown =>
      status === undefined
        ? undefined
        : JSON.parse(
            JSON.stringify(status, (key, value: unknown) =>
              key === 'attemptId' || key === 'uncertainAttemptIds' ? undefined : value,
            ),
          );

    for (const next of [sent('C'), failed('C'), uncertain('C')]) {
      expect(strip(settleStatus(previous, next))).toEqual(
        strip(settleStatusV1(strip(previous) as RecipientStatus | undefined, strip(next) as RecipientStatus)),
      );
    }
  });

  it('keeps the uncertain resend B of a sent message after a later deliberate resend C is accepted', () => {
    const afterB = settleStatus(sent('A'), uncertain('B'));
    const afterC = settleStatus(afterB, sent('C'));

    expect(afterB).toMatchObject({
      status: 'sent',
      attemptId: 'A',
      resendFailure: { outcome: 'uncertain', attemptId: 'B' },
    });
    expect(afterB.uncertainAttemptIds).toBeUndefined();
    expect(afterC).toEqual({ ...sent('C'), uncertainAttemptIds: ['B'] });
  });

  it('keeps an uncertain resend failure that a newer resend failure replaces', () => {
    const afterB = settleStatus(sent('A'), uncertain('B'));

    expect(settleStatus(afterB, uncertain('C'))).toMatchObject({
      resendFailure: { attemptId: 'C' },
      uncertainAttemptIds: ['B'],
    });
    expect(settleStatus(afterB, failed('C'))).toMatchObject({
      resendFailure: { outcome: 'failed', attemptId: 'C' },
      uncertainAttemptIds: ['B'],
    });
  });

  it('lists ids in the order the attempts happened', () => {
    let status = settleStatus(undefined, uncertain('A'));

    for (const next of [uncertain('B'), failed('X'), uncertain('C'), sent('D')]) {
      status = settleStatus(status, next);
    }

    expect(status.uncertainAttemptIds).toEqual(['A', 'B', 'C']);
  });

  it('lists each id once when the same outcome is replayed', () => {
    let status = settleStatus(undefined, uncertain('A'));

    for (const next of [uncertain('B'), uncertain('B'), uncertain('C'), uncertain('C')]) {
      status = settleStatus(status, next);
    }

    expect(status).toMatchObject({ attemptId: 'C', uncertainAttemptIds: ['A', 'B'] });
  });

  it('never invents an id for a record or outcome that has none', () => {
    expect(settleStatus(uncertain(), uncertain())).toEqual(uncertain());
    expect(settleStatus(uncertain(), sent())).toEqual(sent());
    expect(settleStatus(withResend(sent(), uncertain()), sent())).toEqual(sent());
  });

  it('gives the same result when the same outcome is applied twice', () => {
    for (const [, previous] of PREVIOUS) {
      for (const next of [sent('C'), failed('C'), uncertain('C')]) {
        const once = settleStatus(previous, next);

        expect(settleStatus(once, next)).toEqual(once);
      }
    }
  });
});
