import { describe, expect, it } from 'vitest';
import { toSafeJson } from '../../../src/platform/terminal/safe-json';

const INVISIBLE = ['​', '­', ' ', ' ', '‮', '\u0085', '\u001b', '\u{e0001}'];
const UNSAFE = /[^\P{Cc}\n]|[\p{Cf}\p{Zl}\p{Zp}]/u;

describe('toSafeJson', () => {
  it('escapes invisible and control characters as valid JSON escapes', () => {
    const value = { identifier: `ada${INVISIBLE.join('')}@example.com`, list: ['ok'] };

    const json = toSafeJson(value, 2);

    expect(UNSAFE.test(json)).toBe(false);
    expect(JSON.parse(json)).toEqual(value);
  });

  it('keeps the requested indentation', () => {
    expect(toSafeJson({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
  });

  it('refuses values that have no JSON form', () => {
    expect(() => toSafeJson(undefined)).toThrow(TypeError);
  });
});
