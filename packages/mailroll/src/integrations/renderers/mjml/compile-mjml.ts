import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, TemplateRenderError } from '@mailroll/core';

export interface CompiledTemplateFile {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly bytes: number;
}

interface MjmlResult {
  readonly html: string;
}

interface MjmlValidationIssue {
  readonly formattedMessage: string;
}

type Mjml2Html = (source: string, options: Record<string, unknown>) => MjmlResult | Promise<MjmlResult>;

export async function compileTemplate(templateDir: string): Promise<CompiledTemplateFile> {
  const sourcePath = join(templateDir, 'view', 'template.mjml');
  const outputPath = join(templateDir, 'view', 'compiled.html');
  const source = await readFile(sourcePath, 'utf8').catch((error: unknown) => {
    throw new ConfigError(`cannot read ${sourcePath}`, { cause: error });
  });

  const mjml2html = await loadMjml();
  const result = await compileStrict(mjml2html, source, sourcePath);
  const required = [...unique(source, /\{\{[^}]+\}\}/g), ...unique(source, /<!--\s*[A-Z0-9_]+\s*-->/g)];
  const missing = required.filter((token) => !result.html.includes(token));

  if (missing.length > 0) {
    throw new TemplateRenderError(`did not survive MJML compilation: ${missing.join(', ')}`);
  }

  await writeFile(outputPath, result.html, 'utf8');

  return { sourcePath, outputPath, bytes: Buffer.byteLength(result.html) };
}

async function compileStrict(mjml2html: Mjml2Html, source: string, sourcePath: string): Promise<MjmlResult> {
  try {
    return await mjml2html(source, { filePath: sourcePath, validationLevel: 'strict', minify: false });
  } catch (error) {
    const issues = validationIssues(error);

    if (issues === undefined) {
      throw error;
    }

    const details = issues.map((issue) => issue.formattedMessage).join('\n');

    throw new TemplateRenderError(`MJML reported ${String(issues.length)} error(s) in ${sourcePath}:\n${details}`, {
      cause: error,
    });
  }
}

function validationIssues(error: unknown): readonly MjmlValidationIssue[] | undefined {
  if (!(error instanceof Error) || !('errors' in error)) {
    return undefined;
  }

  const reported: unknown = error.errors;

  if (!Array.isArray(reported)) {
    return undefined;
  }

  const issues = (reported as readonly unknown[]).filter(
    (issue): issue is MjmlValidationIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      'formattedMessage' in issue &&
      typeof issue.formattedMessage === 'string',
  );

  return issues.length > 0 ? issues : undefined;
}

async function loadMjml(): Promise<Mjml2Html> {
  try {
    const mod = (await import('mjml')) as { readonly default: Mjml2Html };

    return mod.default;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      error.message.includes("'mjml'")
    ) {
      throw new ConfigError(
        'compiling templates needs the "mjml" package: install it next to mailroll (npm install mjml)',
        { cause: error },
      );
    }

    throw error;
  }
}

function unique(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((m) => m[0]))];
}
