import { describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { buildSelection, type RawSelection } from '../../../src/platform/composition/build-selection';

const base: RawSelection = {
  campaignId: 'acme/newsletter',
  targets: [{ templateId: 'welcome' }],
  connectionIds: ['outlook-1'],
  policy: { kind: 'pending' },
  mode: { kind: 'dry-run' },
};

const untyped = (overrides: Record<string, unknown>): RawSelection => ({ ...base, ...overrides });

function rejection(selection: RawSelection): string {
  try {
    buildSelection(selection);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);

    return (error as ConfigError).message;
  }

  throw new Error('expected buildSelection to reject the selection');
}

describe('buildSelection with untyped (JavaScript) input', () => {
  it('accepts valid addresses and returns them normalized', () => {
    const selection = buildSelection(
      untyped({
        cc: [' boss@example.com '],
        policy: { kind: 'subset', recipients: ['élise@example.com'] },
        mode: { kind: 'test', testRecipient: ' qa@example.com' },
        targets: [{ templateId: 'welcome', cc: ['team@example.com '] }],
      }),
    );

    expect(selection.cc).toEqual(['boss@example.com']);
    expect(selection.policy).toEqual({ kind: 'subset', recipients: ['élise@example.com'] });
    expect(selection.mode).toEqual({ kind: 'test', testRecipient: 'qa@example.com' });
    expect(selection.targets[0]?.cc).toEqual(['team@example.com']);
  });

  it.each([
    ['an invalid address', { cc: ['not-an-address'] }, /^invalid selection: cc\.0: email is not a valid address/],
    ['an empty string', { cc: [''] }, /^invalid selection: cc\.0: email is empty$/],
    [
      'an invisible character',
      { cc: ['ada​@example.com'] },
      /cc\.0: email contains spaces, control or invisible characters/,
    ],
    ['null instead of a list', { cc: null }, /^invalid selection: cc: /],
    ['a number in a list', { cc: [42] }, /^invalid selection: cc\.0: email must be text$/],
    ['an object in a list', { cc: [{ address: 'a@x.co' }] }, /cc\.0: email must be text/],
    ['a string instead of a list', { cc: 'ada@example.com' }, /^invalid selection: cc: /],
    [
      'one invalid address among several',
      { cc: ['ok@example.com', 'bad@', 'ok2@example.com'] },
      /cc\.1: email is not a valid address/,
    ],
    ['an undefined test inbox', { mode: { kind: 'test' } }, /mode\.testRecipient: email must be text/],
    [
      'an invalid subset recipient',
      { policy: { kind: 'subset', recipients: ['ok@example.com', 7] } },
      /policy\.recipients\.1: email must be text/,
    ],
    [
      'an invalid per-list CC',
      { targets: [{ templateId: 'welcome', cc: ['x'] }] },
      /targets\.0\.cc\.0: email is not a valid address/,
    ],
    ['targets that is not a list', { targets: { templateId: 'welcome' } }, /^invalid selection: targets: /],
    ['a missing policy', { policy: undefined }, /^invalid selection: policy: /],
  ])('rejects %s with a configuration error, never a TypeError', (_case, overrides, message) => {
    expect(rejection(untyped(overrides))).toMatch(message);
  });
});
