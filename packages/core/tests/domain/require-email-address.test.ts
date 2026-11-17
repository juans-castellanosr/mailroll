import { describe, expect, it } from 'vitest';
import { requireEmailAddress, requireEmailAddresses } from '../../src/domain/addressing/require-email-address';
import { ConfigError } from '../../src/domain/kernel/errors';

describe('requireEmailAddress', () => {
  it('returns the normalized address', () => {
    expect(requireEmailAddress('  ada@example.com ', 'cc')).toBe('ada@example.com');
  });

  it('names the field and the reason when the address is invalid', () => {
    expect(() => requireEmailAddress('not-an-address', 'cc.1')).toThrow(
      new ConfigError('cc.1: email is not a valid address (it needs exactly one @ between a name and a domain)'),
    );
  });
});

describe('requireEmailAddresses', () => {
  it('rejects a value that is not a list', () => {
    expect(() => requireEmailAddresses('ada@example.com', 'cc')).toThrow(
      new ConfigError('cc: expected a list of email addresses'),
    );
  });

  it('points at the invalid entry inside a list', () => {
    expect(() => requireEmailAddresses(['ada@example.com', 42], 'cc')).toThrow(
      new ConfigError('cc.1: email must be text'),
    );
  });
});
