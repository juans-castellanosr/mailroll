import { describe, expect, it } from 'vitest';
import { normalizeEmail, parseEmailAddress } from '../../src/domain/addressing/email-address';

describe('parseEmailAddress', () => {
  it('accepts a well-formed address', () => {
    expect(parseEmailAddress('teacher@university.example')).toEqual({
      ok: true,
      value: 'teacher@university.example',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseEmailAddress('  teacher@university.example \t')).toEqual({
      ok: true,
      value: 'teacher@university.example',
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['no-at-sign.edu', 'missing @'],
    ['a@b@c.edu', 'multiple @'],
    ['user@nodotdomain', 'domain without a dot'],
    ['has space@x.edu', 'whitespace in local part'],
    ['a-->b@x.edu', 'angle bracket'],
    ['@x.edu', 'empty local part'],
    ['user@.edu', 'empty domain label'],
  ])('rejects %j (%s)', (raw) => {
    const outcome = parseEmailAddress(raw);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasons.length).toBeGreaterThan(0);
    }
  });

  it('rejects an address longer than 254 characters', () => {
    const outcome = parseEmailAddress(`${'a'.repeat(250)}@b.co`);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reasons.some((r) => r.includes('254'))).toBe(true);
    }
  });

  it('normalizes to lower case for a stable key', () => {
    const outcome = parseEmailAddress('Teacher@University.EXAMPLE');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(normalizeEmail(outcome.value)).toBe('teacher@university.example');
    }
  });

  it.each([
    ['victim@example.org\u200b', 'zero-width space'],
    ['victim@exam\u202eple.org', 'right-to-left override'],
    ['x\u001b[8m@hidden.example', 'terminal escape'],
    ['a@x.example,b', 'comma'],
    ['a@x.example;b@y.example', 'semicolon'],
    ['"quoted"@x.example', 'quoted local part'],
    ['a..b@x.example', 'consecutive dots'],
    ['.a@x.example', 'leading dot'],
    ['a@-x.example', 'label starting with a hyphen'],
    ['a@x.e', 'one-letter top-level domain'],
  ])('rejects %j (%s)', (raw) => {
    expect(parseEmailAddress(raw).ok).toBe(false);
  });

  it.each(['first.last+tag@sub.example.co', "o'brien@example.ie", 'josé@ejemplo.example', 'a_b-c@x.xn--p1ai'])(
    'accepts %j',
    (raw) => {
      expect(parseEmailAddress(raw).ok).toBe(true);
    },
  );

  it('normalizes composed and decomposed accents to one address (NFC)', () => {
    const composed = parseEmailAddress('jos\u00e9@x.co');
    const decomposed = parseEmailAddress('jose\u0301@x.co');

    expect(composed.ok && decomposed.ok && composed.value === decomposed.value).toBe(true);
  });
});

describe('parseEmailAddress input types', () => {
  it.each([null, undefined, 42, {}, ['a@x.co'], true])('rejects %j without throwing', (value) => {
    expect(parseEmailAddress(value)).toEqual({ ok: false, reasons: ['email must be text'] });
  });
});

describe('parseEmailAddress length limits (UTF-8 bytes)', () => {
  const at = (local: string, domain = 'example.com'): string => `${local}@${domain}`;
  const label = (length: number): string => 'a'.repeat(length);

  it('accepts a 64-byte ASCII local part and rejects 65', () => {
    expect(parseEmailAddress(at('a'.repeat(64))).ok).toBe(true);
    expect(parseEmailAddress(at('a'.repeat(65)))).toEqual({
      ok: false,
      reasons: ['email is not a valid address (the part before the @ exceeds 64 bytes)'],
    });
  });

  it('counts bytes, not characters, for multibyte local parts', () => {
    const fits = 'é'.repeat(32);
    const tooLong = 'é'.repeat(33);

    expect(fits.length).toBe(32);
    expect(parseEmailAddress(at(fits)).ok).toBe(true);
    expect(parseEmailAddress(at(tooLong)).ok).toBe(false);
  });

  it('measures after NFC, so decomposed and composed forms count the same', () => {
    const decomposed = 'é'.repeat(32);

    expect(decomposed.length).toBe(64);

    const outcome = parseEmailAddress(at(decomposed));

    expect(outcome).toEqual({ ok: true, value: at('é'.repeat(32)) });
    expect(parseEmailAddress(at('é'.repeat(33))).ok).toBe(false);
  });

  it('accepts a 254-byte address and rejects 255', () => {
    const domain = `${label(63)}.${label(63)}.${label(63)}.${label(58)}.com`;

    expect(at('a'.repeat(1), domain).length).toBe(256);

    const exact = `${'a'.repeat(1)}@${label(63)}.${label(63)}.${label(63)}.${label(56)}.com`;

    expect(exact.length).toBe(254);
    expect(parseEmailAddress(exact).ok).toBe(true);

    const over = `${'a'.repeat(2)}@${label(63)}.${label(63)}.${label(63)}.${label(56)}.com`;

    expect(parseEmailAddress(over)).toEqual({ ok: false, reasons: ['email exceeds 254 bytes'] });
  });

  it('counts multibyte characters in the total length', () => {
    const domain = `${label(63)}.${label(63)}.${label(63)}.${label(40)}.com`;
    const ascii = `${'a'.repeat(17)}@${domain}`;

    expect(parseEmailAddress(ascii).ok).toBe(true);

    const multibyte = `${'é'.repeat(17)}@${domain}`;

    expect(multibyte.length).toBe(ascii.length);
    expect(parseEmailAddress(multibyte)).toEqual({ ok: false, reasons: ['email exceeds 254 bytes'] });
  });

  it('accepts a 63-character ASCII domain label and rejects 64', () => {
    expect(parseEmailAddress(at('a', `${label(63)}.com`)).ok).toBe(true);
    expect(parseEmailAddress(at('a', `${label(64)}.com`)).ok).toBe(false);
  });
});
