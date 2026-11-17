import { TemplateRenderError } from '../domain/kernel/errors';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match: string, name: string): string => {
    const value = values[name];

    if (value === undefined) {
      throw new TemplateRenderError(`unresolved template placeholder "{{${name}}}"`);
    }

    return escapeHtml(value);
  });
}
