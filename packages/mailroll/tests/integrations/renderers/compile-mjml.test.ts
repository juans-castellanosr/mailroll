import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TemplateRenderError } from '@mailroll/core';
import { compileTemplate } from '../../../src/integrations/renderers/mjml/compile-mjml';

let templateDir: string;

beforeEach(() => {
  templateDir = mkdtempSync(join(tmpdir(), 'mailroll-mjml-'));
  mkdirSync(join(templateDir, 'view'));
});
afterEach(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

function writeSource(mjml: string): void {
  writeFileSync(join(templateDir, 'view', 'template.mjml'), mjml, 'utf8');
}

const compiledPath = (): string => join(templateDir, 'view', 'compiled.html');

describe('compileTemplate', () => {
  it('writes compiled HTML that keeps placeholders and comment markers', async () => {
    writeSource(
      '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}<!-- STEPS --></mj-text></mj-column></mj-section></mj-body></mjml>',
    );

    const result = await compileTemplate(templateDir);

    const html = readFileSync(compiledPath(), 'utf8');

    expect(result.outputPath).toBe(compiledPath());
    expect(html).toContain('{{firstName}}');
    expect(html).toContain('<!-- STEPS -->');
  });

  it('reports invalid MJML as a template error listing every problem, and writes nothing', async () => {
    writeSource(
      '<mjml><mj-body><mj-section><mj-column><mj-text unknown-attribute="x">Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
    );

    const error: unknown = await compileTemplate(templateDir).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemplateRenderError);
    expect((error as Error).message).toContain(
      `MJML reported 1 error(s) in ${join(templateDir, 'view', 'template.mjml')}:`,
    );
    expect((error as Error).message).toContain('unknown-attribute');
    expect(existsSync(compiledPath())).toBe(false);
  });
});
