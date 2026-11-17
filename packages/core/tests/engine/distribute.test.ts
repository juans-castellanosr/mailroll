import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import { distribute } from '../../src/engine/distribute';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

const recips = (n: number): EmailAddress[] => Array.from({ length: n }, (_, i) => addr(`r${String(i)}@x.co`));

describe('distribute', () => {
  it('round-robins recipients across connections in stable order', () => {
    const result = distribute(recips(5), ['a', 'b']);

    expect(result.map((a) => a.connectionId)).toEqual(['a', 'b', 'a', 'b', 'a']);
    expect(result.map((a) => a.recipient)).toEqual(['r0@x.co', 'r1@x.co', 'r2@x.co', 'r3@x.co', 'r4@x.co']);
  });

  it('routes everything to the sole connection', () => {
    expect(distribute(recips(3), ['only']).map((a) => a.connectionId)).toEqual(['only', 'only', 'only']);
  });

  it('returns nothing when there are no connections', () => {
    expect(distribute(recips(3), [])).toEqual([]);
  });

  it('returns nothing when there are no recipients', () => {
    expect(distribute([], ['a', 'b'])).toEqual([]);
  });
});
