import { describe, expect, it } from 'vitest';
import type { SenderCapabilities } from '../../src/contracts/sender';
import { type SendExpectation, settleSend, validateSendOutcome } from '../../src/contracts/validate-send-outcome';
import { requireEmailAddress } from '../../src/domain/addressing/require-email-address';
import type { Message } from '../../src/domain/messaging/message';

const PER_RECIPIENT: SenderCapabilities = {
  cc: true,
  replyTo: true,
  inlineAttachments: false,
  sentCopy: 'never',
  recipientAcceptance: 'per-recipient',
};
const TRANSACTION: SenderCapabilities = { ...PER_RECIPIENT, recipientAcceptance: 'transaction', sentCopy: 'optional' };

function message(cc: readonly string[] = []): Message {
  return {
    to: requireEmailAddress('ana@example.test', 'to'),
    subject: 's',
    html: '<p>x</p>',
    ...(cc.length > 0 ? { cc: cc.map((address) => requireEmailAddress(address, 'cc')) } : {}),
  };
}

const expectationFor = (capabilities: SenderCapabilities, cc: readonly string[] = []): SendExpectation => ({
  capabilities,
  message: message(cc),
});

describe('validateSendOutcome', () => {
  describe('valid results', () => {
    it('keeps an accepted result and its provider reference', () => {
      expect(
        validateSendOutcome({ outcome: 'accepted', providerMessageId: 'abc' }, expectationFor(TRANSACTION)),
      ).toEqual({
        outcome: 'accepted',
        providerMessageId: 'abc',
      });
    });

    it('keeps a certain rejection with its reason, scope and retry hint', () => {
      const raw = { outcome: 'not-accepted', reason: 'throttled', scope: 'connection', retryAfterMs: 0, detail: '421' };

      expect(validateSendOutcome(raw, expectationFor(TRANSACTION))).toEqual(raw);
    });

    it('keeps an unknown result', () => {
      expect(validateSendOutcome({ outcome: 'unknown', detail: 'timeout' }, expectationFor(TRANSACTION))).toEqual({
        outcome: 'unknown',
        detail: 'timeout',
      });
    });
  });

  describe('invalid results never claim certainty', () => {
    it.each([
      ['null', null, 'the send result is not an object'],
      ['a string', 'accepted', 'the send result is not an object'],
      ['an unknown outcome', { outcome: 'delivered' }, '"outcome" must be'],
      ['an unknown reason', { outcome: 'not-accepted', reason: 'blocked', scope: 'message', detail: 'x' }, '"reason"'],
      ['an unknown scope', { outcome: 'not-accepted', reason: 'transient', scope: 'server', detail: 'x' }, '"scope"'],
      ['a missing scope', { outcome: 'not-accepted', reason: 'transient', detail: 'x' }, '"scope"'],
      [
        'a rejection whose detail is only spaces',
        { outcome: 'not-accepted', reason: 'permanent', scope: 'message', detail: '   ' },
        '"detail"',
      ],
      [
        'a provider reference that is only spaces',
        { outcome: 'accepted', providerMessageId: '  ' },
        '"providerMessageId"',
      ],
      [
        'an auth rejection scoped to one message',
        { outcome: 'not-accepted', reason: 'auth', scope: 'message', detail: 'x' },
        '"auth"',
      ],
      [
        'a negative retry hint',
        { outcome: 'not-accepted', reason: 'throttled', scope: 'message', retryAfterMs: -1, detail: 'x' },
        '"retryAfterMs"',
      ],
      [
        'an infinite retry hint',
        { outcome: 'not-accepted', reason: 'throttled', scope: 'message', retryAfterMs: Infinity, detail: 'x' },
        '"retryAfterMs"',
      ],
      [
        'a textual retry hint',
        { outcome: 'not-accepted', reason: 'throttled', scope: 'message', retryAfterMs: '5', detail: 'x' },
        '"retryAfterMs"',
      ],
      ['a rejection without detail', { outcome: 'not-accepted', reason: 'permanent', scope: 'message' }, '"detail"'],
      ['an empty provider reference', { outcome: 'accepted', providerMessageId: '' }, '"providerMessageId"'],
    ])('turns %s into unknown', (_label, raw, violation) => {
      const outcome = validateSendOutcome(raw, expectationFor(TRANSACTION));

      expect(outcome.outcome).toBe('unknown');
      expect(outcome.outcome === 'unknown' ? outcome.violation : undefined).toContain(violation);
    });

    it('keeps an unknown result unknown even when its detail is missing', () => {
      expect(validateSendOutcome({ outcome: 'unknown' }, expectationFor(TRANSACTION))).toMatchObject({
        outcome: 'unknown',
        violation: '"detail" must be non-empty text',
      });
    });

    it('turns a result whose fields throw when read into unknown', () => {
      const hostile = new Proxy(
        {},
        {
          get: () => {
            throw new Error('trap');
          },
        },
      );

      expect(validateSendOutcome(hostile, expectationFor(TRANSACTION))).toMatchObject({
        outcome: 'unknown',
        violation: 'the send result could not read "outcome" (Error: trap)',
      });
    });

    it('reads each field once, so a getter cannot change its answer between checks', () => {
      let reads = 0;
      const raw = {
        get outcome() {
          reads += 1;

          return reads === 1 ? 'not-accepted' : 'accepted';
        },
        reason: 'transient',
        scope: 'message',
        detail: 'x',
      };

      expect(validateSendOutcome(raw, expectationFor(TRANSACTION))).toMatchObject({ outcome: 'not-accepted' });
      expect(reads).toBe(1);
    });
  });

  describe('ccRejected', () => {
    it('requires the list when the sender observes each recipient and the message has a CC', () => {
      expect(
        validateSendOutcome({ outcome: 'accepted' }, expectationFor(PER_RECIPIENT, ['cc@example.test'])),
      ).toMatchObject({
        outcome: 'unknown',
        violation: '"ccRejected" is required when the sender observes each recipient and the message has a CC',
      });
    });

    it('keeps an empty list as "observed: no CC was rejected"', () => {
      expect(
        validateSendOutcome(
          { outcome: 'accepted', ccRejected: [] },
          expectationFor(PER_RECIPIENT, ['cc@example.test']),
        ),
      ).toEqual({ outcome: 'accepted', ccRejected: [] });
    });

    it('keeps the rejected CC, matched case-insensitively to the message CC', () => {
      expect(
        validateSendOutcome(
          { outcome: 'accepted', ccRejected: ['Boss@Example.test'] },
          expectationFor(PER_RECIPIENT, ['boss@example.test', 'team@example.test']),
        ),
      ).toEqual({ outcome: 'accepted', ccRejected: ['boss@example.test'] });
    });

    it.each([
      ['an address that was not in the CC', ['stranger@example.test'], "not one of the message's CC"],
      ['the same CC twice', ['boss@example.test', 'BOSS@example.test'], 'the same CC twice'],
      ['something that is not an address', [42], "not one of the message's CC"],
      ['a value that is not a list', 'boss@example.test', '"ccRejected" is not a list'],
      [
        'more entries than the message has CC',
        ['boss@example.test', 'team@example.test', 'x@example.test'],
        'has more than 2 items',
      ],
    ])('turns a list with %s into unknown', (_label, ccRejected, violation) => {
      const outcome = validateSendOutcome(
        { outcome: 'accepted', ccRejected },
        expectationFor(PER_RECIPIENT, ['boss@example.test', 'team@example.test']),
      );

      expect(outcome).toMatchObject({ outcome: 'unknown' });
      expect(outcome.outcome === 'unknown' ? outcome.violation : undefined).toContain(violation);
    });

    it('accepts no list from a sender that only observes whole transactions: not observable is not "none rejected"', () => {
      expect(validateSendOutcome({ outcome: 'accepted' }, expectationFor(TRANSACTION, ['cc@example.test']))).toEqual({
        outcome: 'accepted',
      });
    });

    it('turns a list from a sender that only observes whole transactions into unknown', () => {
      expect(
        validateSendOutcome({ outcome: 'accepted', ccRejected: [] }, expectationFor(TRANSACTION, ['cc@example.test'])),
      ).toMatchObject({
        outcome: 'unknown',
        violation: '"ccRejected" must be absent when the sender only observes whole transactions',
      });
    });

    it('turns a list for a message without CC into unknown', () => {
      expect(validateSendOutcome({ outcome: 'accepted', ccRejected: [] }, expectationFor(PER_RECIPIENT))).toMatchObject(
        {
          outcome: 'unknown',
          violation: '"ccRejected" must be absent when the message has no CC',
        },
      );
    });
  });
});

describe('settleSend', () => {
  it('validates what the send resolves to', async () => {
    await expect(
      settleSend(() => Promise.resolve({ outcome: 'accepted' }), expectationFor(TRANSACTION)),
    ).resolves.toEqual({
      outcome: 'accepted',
    });
  });

  it('turns a rejected send into unknown', async () => {
    await expect(
      settleSend(() => Promise.reject(new Error('socket closed')), expectationFor(TRANSACTION)),
    ).resolves.toEqual({
      outcome: 'unknown',
      detail: 'the send failed with an error, so the message may or may not have been sent: Error: socket closed',
    });
  });

  it('turns a send that throws before returning a promise into unknown', async () => {
    const outcome = await settleSend(() => {
      throw new TypeError('not a function');
    }, expectationFor(TRANSACTION));

    expect(outcome).toMatchObject({ outcome: 'unknown' });
  });
});
