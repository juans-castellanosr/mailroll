import { describe, expect, it } from 'vitest';
import { foldJournal } from '../../src/domain/run/fold-journal';
import {
  emptyState,
  INTERRUPTED_MESSAGE,
  type RecipientJournalEntry,
  type RecipientStatus,
  settleStatus,
  type TemplateState,
} from '../../src/domain/run/template-state';

const EMAIL = 'a@x.co';

const stateWith = (status: RecipientStatus | undefined, updatedAt = 'T0'): TemplateState => ({
  ...emptyState('t'),
  recipients: status === undefined ? {} : { [EMAIL]: status },
  updatedAt,
});

const PREVIOUS: readonly (RecipientStatus | undefined)[] = [
  undefined,
  { status: 'sent', at: 'T0', connectionId: 'x', attemptId: 'A' },
  settleStatus(
    { status: 'sent', at: 'T0', connectionId: 'x', attemptId: 'A' },
    { status: 'uncertain', at: 'T0', connectionId: 'x', message: 'm', attemptId: 'B' },
  ),
  { status: 'failed', at: 'T0', connectionId: 'x', category: 'transient', message: 'm', attemptId: 'A' },
  { status: 'uncertain', at: 'T0', connectionId: 'x', message: 'm', attemptId: 'A' },
  { status: 'uncertain', at: 'T0', connectionId: 'x', message: 'm', attemptId: 'A', uncertainAttemptIds: ['Z'] },
  { status: 'uncertain', at: 'T0', connectionId: 'x', message: 'm' },
];

function symbols(position: number): readonly RecipientJournalEntry[] {
  const at = `T${String(position + 1)}`;
  const id = `J${String(position + 1)}`;

  return [
    { email: EMAIL, intent: { at, connectionId: 'x', attemptId: id } },
    { email: EMAIL, intent: { at, connectionId: 'x' } },
    { email: EMAIL, status: { status: 'sent', at, connectionId: 'x', attemptId: id } },
    {
      email: EMAIL,
      status: { status: 'failed', at, connectionId: 'x', category: 'permanent', message: 'm', attemptId: id },
    },
    { email: EMAIL, status: { status: 'uncertain', at, connectionId: 'x', message: 'm', attemptId: id } },
    { email: EMAIL, released: { at } },
  ];
}

function journals(length: number): RecipientJournalEntry[][] {
  if (length === 0) {
    return [[]];
  }

  return journals(length - 1).flatMap((prefix) => symbols(length - 1).map((entry) => [...prefix, entry]));
}

const ALL_JOURNALS = [0, 1, 2, 3].flatMap(journals);

describe('foldJournal', () => {
  it(`replays every journal of up to 3 entries over every previous record to the same whole state twice (${String(ALL_JOURNALS.length * PREVIOUS.length)} cases)`, () => {
    for (const previous of PREVIOUS) {
      for (const journal of ALL_JOURNALS) {
        const once = foldJournal(stateWith(previous), journal);

        expect(foldJournal(once, journal)).toEqual(once);
      }
    }
  });

  it('turns an open intent into an uncertain record that keeps the id of its attempt', () => {
    const state = foldJournal(emptyState('t'), [
      { email: EMAIL, intent: { at: 'T1', connectionId: 'x', attemptId: 'A' } },
    ]);

    expect(state.recipients[EMAIL]).toEqual({
      status: 'uncertain',
      at: 'T1',
      connectionId: 'x',
      message: INTERRUPTED_MESSAGE,
      attemptId: 'A',
    });
  });

  it('gives no attempt id to an interrupted intent recorded without one', () => {
    const state = foldJournal(emptyState('t'), [{ email: EMAIL, intent: { at: 'T1', connectionId: 'x' } }]);

    expect(state.recipients[EMAIL]).toEqual({
      status: 'uncertain',
      at: 'T1',
      connectionId: 'x',
      message: INTERRUPTED_MESSAGE,
    });
  });

  it('keeps an earlier uncertain attempt when an interrupted resend replaces it', () => {
    const state = foldJournal(
      stateWith({ status: 'uncertain', at: 'T0', connectionId: 'x', message: 'm', attemptId: 'A' }),
      [{ email: EMAIL, intent: { at: 'T1', connectionId: 'x', attemptId: 'B' } }],
    );

    expect(state.recipients[EMAIL]).toMatchObject({ attemptId: 'B', uncertainAttemptIds: ['A'] });
  });

  it('closes an intent with its outcome or its release, and dates the state by the last outcome', () => {
    const state = foldJournal(stateWith(undefined), [
      { email: EMAIL, intent: { at: 'T1', connectionId: 'x', attemptId: 'A' } },
      { email: EMAIL, status: { status: 'sent', at: 'T2', connectionId: 'x', attemptId: 'A' } },
      { email: 'b@x.co', intent: { at: 'T3', connectionId: 'x', attemptId: 'B' } },
      { email: 'b@x.co', released: { at: 'T4' } },
    ]);

    expect(state.recipients).toEqual({ [EMAIL]: { status: 'sent', at: 'T2', connectionId: 'x', attemptId: 'A' } });
    expect(state.updatedAt).toBe('T2');
  });

  it('leaves the snapshot it folds over untouched', () => {
    const snapshot = Object.freeze(
      stateWith({ status: 'failed', at: 'T0', connectionId: 'x', category: 'transient', message: 'm' }),
    );

    foldJournal(snapshot, [{ email: EMAIL, intent: { at: 'T1', connectionId: 'x' } }]);

    expect(snapshot.recipients[EMAIL]?.status).toBe('failed');
  });
});

describe('foldJournal with an intent that a later intent supersedes (left by a run that died)', () => {
  const intent = (attemptId: string, at: string): RecipientJournalEntry => ({
    email: EMAIL,
    intent: { at, connectionId: 'x', attemptId },
  });

  it('keeps the superseded attempt as an earlier uncertain attempt', () => {
    const state = foldJournal(emptyState('t'), [intent('X', 'T1'), intent('Y', 'T2')]);

    expect(state.recipients[EMAIL]).toMatchObject({ status: 'uncertain', attemptId: 'Y', uncertainAttemptIds: ['X'] });
  });

  it('keeps the recipient uncertain when only the later intent was released', () => {
    const state = foldJournal(
      stateWith({ status: 'failed', at: 'T0', connectionId: 'x', category: 'transient', message: 'm' }),
      [intent('X', 'T1'), intent('Y', 'T2'), { email: EMAIL, released: { at: 'T3' } }],
    );

    expect(state.recipients[EMAIL]).toEqual({
      status: 'uncertain',
      at: 'T1',
      connectionId: 'x',
      message: INTERRUPTED_MESSAGE,
      attemptId: 'X',
    });
  });

  it('keeps a sent recipient sent and records the superseded attempt as an uncertain resend', () => {
    const state = foldJournal(stateWith({ status: 'sent', at: 'T0', connectionId: 'x', attemptId: 'A' }), [
      intent('X', 'T1'),
      intent('Y', 'T2'),
      { email: EMAIL, released: { at: 'T3' } },
    ]);

    expect(state.recipients[EMAIL]).toMatchObject({
      status: 'sent',
      attemptId: 'A',
      resendFailure: { outcome: 'uncertain', attemptId: 'X', message: INTERRUPTED_MESSAGE },
    });
  });
});
