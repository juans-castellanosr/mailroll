import { describe, expect, it } from 'vitest';
import { SendError, recognizeSendError } from '../../src/domain/kernel/errors';

function lookalike(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('boom'), { name: 'SendError', ...fields });
}

describe('recognizeSendError', () => {
  it('reads category, message and retry hint from a SendError', () => {
    expect(recognizeSendError(new SendError('slow down', 'throttled', { retryAfterMs: 2_000 }))).toEqual({
      category: 'throttled',
      message: 'slow down',
      retryAfterMs: 2_000,
    });
  });

  it('recognizes a SendError built by another copy of mailroll by its name and category', () => {
    expect(recognizeSendError(lookalike({ category: 'uncertain' }))).toEqual({
      category: 'uncertain',
      message: 'boom',
    });
  });

  it.each([
    ['an unknown category', lookalike({ category: 'temporary' })],
    ['a missing category', lookalike({})],
    ['another error name', Object.assign(new Error('boom'), { category: 'transient' })],
    ['a plain object', { name: 'SendError', message: 'boom', category: 'transient' }],
    ['a string', 'boom'],
    ['undefined', undefined],
  ])('does not recognize %s', (_label, error) => {
    expect(recognizeSendError(error)).toBeUndefined();
  });

  it('rejects a SendError whose category is outside the known set', () => {
    expect(recognizeSendError(new SendError('boom', 'temporary' as SendError['category']))).toBeUndefined();
  });

  it.each([
    ['negative', -1],
    ['not finite', Number.POSITIVE_INFINITY],
    ['not a number', '2000'],
  ])('drops a retry hint that is %s', (_label, retryAfterMs) => {
    expect(recognizeSendError(lookalike({ category: 'throttled', retryAfterMs }))).toEqual({
      category: 'throttled',
      message: 'boom',
    });
  });
});
