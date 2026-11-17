import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Template, TemplateRenderError } from '@mailroll/core';
import { loadCompiledTemplate } from '../../../src/integrations/renderers/mjml/load-compiled-template';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailroll-compiled-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function templateIn(templateDir: string): Template {
  return {
    id: 'welcome',
    campaignId: 'acme/onboarding',
    connectionIds: ['outlook-1'],
    ccPolicy: 'optional',
    dir: templateDir,
    dataDir: join(templateDir, 'data'),
    stateDir: join(templateDir, '.state'),
    assetsDir: join(templateDir, 'view', 'assets'),
    compiledHtmlPath: join(templateDir, 'compiled.html'),
    context: {},
  };
}

describe('loadCompiledTemplate', () => {
  it('returns the compiled HTML', async () => {
    writeFileSync(join(dir, 'compiled.html'), '<p>{{ name }}</p>', 'utf8');

    await expect(loadCompiledTemplate(templateIn(dir))).resolves.toBe('<p>{{ name }}</p>');
  });

  it('names the real command that builds a missing compiled template', async () => {
    const error: unknown = await loadCompiledTemplate(templateIn(dir)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemplateRenderError);
    expect((error as Error).message).toContain(`mailroll build-template ${dir}`);
    expect((error as Error).message).not.toContain('pnpm');
  });
});
