import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress, type RecipientStatus, type TemplateState } from '@mailroll/core';
import {
  countList,
  describeStatus,
  evidenceOf,
  formatCounts,
  type ListStatus,
} from '../../../src/platform/status/list-status';
import { listTemplate } from '../../support/staged-list';

function address(raw: string): EmailAddress {
  const parsed = parseEmailAddress(raw);

  if (!parsed.ok) {
    throw new Error(`test setup: bad address ${raw}`);
  }

  return parsed.value;
}

const C = 'x';
const RECORDS: Readonly<Record<string, RecipientStatus>> = {
  'plain@x.co': { status: 'sent', at: 'T1', connectionId: C, attemptId: 'A' },
  'failed@x.co': { status: 'failed', at: 'T1', connectionId: C, category: 'permanent', message: 'm', attemptId: 'B' },
  'unsure@x.co': { status: 'uncertain', at: 'T1', connectionId: C, message: 'm' },
  'cc@x.co': {
    status: 'sent',
    at: 'T1',
    connectionId: C,
    attemptId: 'C',
    providerMessageId: 'p-1',
    cc: { rejected: ['records@x.co'], required: false },
  },
  'earlier@x.co': { status: 'sent', at: 'T2', connectionId: C, attemptId: 'E', uncertainAttemptIds: ['D'] },
  'resend@x.co': {
    status: 'sent',
    at: 'T1',
    connectionId: C,
    attemptId: 'F',
    resendFailure: { at: 'T2', connectionId: C, outcome: 'uncertain', message: 'm', attemptId: 'G' },
  },
  'ccok@x.co': { status: 'sent', at: 'T1', connectionId: C, cc: { rejected: [], required: true } },
};

const state: TemplateState = { version: 2, templateId: 'welcome', recipients: RECORDS, updatedAt: 'T2' };
const list: ListStatus = {
  template: listTemplate('unused.json'),
  dataFile: 'list.csv',
  recipients: [...Object.keys(RECORDS), 'new@x.co'].map(address),
  rejected: [],
  state,
  fingerprint: 'unused',
};

describe('evidence in status', () => {
  it('lists uncertain records, CC rejections, earlier uncertain attempts and uncertain resends, and nothing else', () => {
    expect(evidenceOf(list)).toEqual([
      { email: 'unsure@x.co', status: 'uncertain', at: 'T1' },
      {
        email: 'cc@x.co',
        status: 'sent',
        at: 'T1',
        attemptId: 'C',
        providerMessageId: 'p-1',
        cc: { rejected: ['records@x.co'], required: false },
      },
      { email: 'earlier@x.co', status: 'sent', at: 'T2', attemptId: 'E', uncertainAttemptIds: ['D'] },
      { email: 'resend@x.co', status: 'sent', at: 'T1', attemptId: 'F', uncertainResend: { at: 'T2', attemptId: 'G' } },
    ]);
  });

  it('describes a rejected CC next to the sent status, without turning the main recipient into a rejection', () => {
    expect(describeStatus(RECORDS['cc@x.co'])).toBe('sent T1 (CC rejected: records@x.co)');
    expect(
      describeStatus({
        status: 'sent',
        at: '2026-01-01T00:00:00Z',
        connectionId: C,
        cc: { rejected: ['a@x.co'], required: true },
      }),
    ).toBe('sent 2026-01-01 (CC rejected, required: a@x.co)');
    expect(describeStatus(RECORDS['ccok@x.co'])).toBe('sent T1');
  });

  it('counts each list by status, with pending as the recipients neither sent nor uncertain', () => {
    expect(countList(list)).toEqual({
      total: 8,
      sent: 5,
      failed: 1,
      uncertain: 1,
      pending: 2,
      rejected: 0,
      ccRejectedMessages: 1,
      requiredCcRejectedMessages: 0,
    });
    expect(formatCounts(countList(list))).toBe(
      '8 in list · sent 5 · failed 1 · pending 2 · uncertain 1 · CC rejected 1 (0 required)',
    );
  });

  it('describes each status, including a later resend that failed or is uncertain', () => {
    expect(describeStatus(RECORDS['resend@x.co'])).toBe('sent T1 (a later resend is uncertain)');
    expect(
      describeStatus({
        status: 'sent',
        at: '2026-01-10T10:00:01.000Z',
        connectionId: C,
        resendFailure: { at: 'T2', connectionId: C, outcome: 'failed', message: 'm', category: 'transient' },
      }),
    ).toBe('sent 2026-01-10 (a later resend failed)');
    expect(describeStatus(RECORDS['failed@x.co'])).toBe('failed T1 (permanent)');
    expect(describeStatus(RECORDS['unsure@x.co'])).toBe(
      'UNCERTAIN T1 — may have been delivered; check before resending',
    );
    expect(describeStatus(RECORDS['new@x.co'])).toBe('not sent yet');
  });
});
