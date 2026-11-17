import { describe, expect, it } from 'vitest';
import { dispositionOf } from '../../src/contracts/outcome-disposition';
import type { SenderCapabilities } from '../../src/contracts/sender';
import { validateSendOutcome } from '../../src/contracts/validate-send-outcome';
import { requireEmailAddress } from '../../src/domain/addressing/require-email-address';
import type { Message } from '../../src/domain/messaging/message';

const capabilities: SenderCapabilities = {
  cc: true,
  replyTo: true,
  inlineAttachments: false,
  sentCopy: 'never',
  recipientAcceptance: 'per-recipient',
};
const message: Message = {
  to: requireEmailAddress('ana@example.test', 'to'),
  subject: 's',
  html: 'x',
  cc: [requireEmailAddress('cc@example.test', 'cc')],
};

const dispositionFor = (raw: unknown) => dispositionOf(validateSendOutcome(raw, { capabilities, message }));
const rejection = (reason: string, scope: string) => ({ outcome: 'not-accepted', reason, scope, detail: 'x' });

describe('dispositionOf', () => {
  it.each([
    ['accepted', { outcome: 'accepted', ccRejected: [] }, { kind: 'record-sent' }],
    ['unknown', { outcome: 'unknown', detail: 'x' }, { kind: 'record-uncertain' }],
    ['transient, message', rejection('transient', 'message'), { kind: 'retry', whenExhausted: 'record-failed' }],
    ['throttled, message', rejection('throttled', 'message'), { kind: 'retry', whenExhausted: 'record-failed' }],
    ['permanent, message', rejection('permanent', 'message'), { kind: 'record-failed' }],
    [
      'transient, connection',
      rejection('transient', 'connection'),
      { kind: 'retry', whenExhausted: 'stop-connection' },
    ],
    [
      'throttled, connection',
      rejection('throttled', 'connection'),
      { kind: 'retry', whenExhausted: 'stop-connection' },
    ],
    ['permanent, connection', rejection('permanent', 'connection'), { kind: 'stop-connection' }],
    ['auth, connection', rejection('auth', 'connection'), { kind: 'stop-connection' }],
  ])('maps %s to its core decision', (_label, raw, disposition) => {
    expect(dispositionFor(raw)).toEqual(disposition);
  });

  it.each([
    ['nothing', undefined],
    ['an unknown scope', rejection('transient', 'everywhere')],
    ['an auth rejection scoped to one message', rejection('auth', 'message')],
    ['an acceptance missing its observed CC list', { outcome: 'accepted' }],
    ['an acceptance naming a stranger as rejected CC', { outcome: 'accepted', ccRejected: ['stranger@example.test'] }],
    ['a negative retry hint', { ...rejection('transient', 'message'), retryAfterMs: -5 }],
  ])('never retries a result it could not trust: %s', (_label, raw) => {
    expect(dispositionFor(raw)).toEqual({ kind: 'record-uncertain' });
  });
});
