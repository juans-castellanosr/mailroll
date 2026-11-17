import { describe, expect, it } from 'vitest';
import { TemplateRenderError } from '../../src/domain/kernel/errors';
import { escapeHtml, substitute } from '../../src/rendering/substitute';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});

describe('substitute', () => {
  it('replaces and HTML-escapes known placeholders', () => {
    expect(substitute('<p>{{name}}</p>', { name: '<script>' })).toBe('<p>&lt;script&gt;</p>');
  });

  it('does not recursively expand a value that contains a placeholder', () => {
    expect(substitute('{{a}}', { a: '{{b}}' })).toBe('{{b}}');
  });

  it('escapes ampersands in URL values', () => {
    expect(substitute('href="{{u}}"', { u: 'https://x/y?a=1&b=2' })).toBe('href="https://x/y?a=1&amp;b=2"');
  });

  it('throws TemplateRenderError for an unknown placeholder', () => {
    expect(() => substitute('{{missing}}', {})).toThrow(TemplateRenderError);
  });
});
