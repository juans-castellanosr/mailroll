import { describe, expect, it } from 'vitest';
import { forTerminal } from '../../../src/platform/terminal/terminal-text';

describe('forTerminal', () => {
  it('shows escape sequences, bidi overrides and zero-width marks as visible codes', () => {
    expect(forTerminal('x\u001b[2Ky')).toBe('x\\u{1b}[2Ky');
    expect(forTerminal('a‮b​c')).toBe('a\\u{202e}b\\u{200b}c');
  });

  it('keeps the program layout (line feeds, tabs) and ordinary text, accents included', () => {
    expect(forTerminal('Zoë Ångström\n\tsent')).toBe('Zoë Ångström\n\tsent');
  });
});
