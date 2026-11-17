import { readFile } from 'node:fs/promises';
import { type Template, TemplateRenderError } from '@mailroll/core';

export async function loadCompiledTemplate(template: Template): Promise<string> {
  try {
    return await readFile(template.compiledHtmlPath, 'utf8');
  } catch (error) {
    throw new TemplateRenderError(
      `compiled template not found at ${template.compiledHtmlPath} — write it, or compile view/template.mjml with "mailroll build-template ${template.dir}"`,
      { cause: error },
    );
  }
}
