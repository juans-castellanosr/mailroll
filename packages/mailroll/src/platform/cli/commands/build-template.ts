import { type CliContext, EXIT } from '../context';
import { compileTemplate } from '../../../integrations/renderers/mjml/compile-mjml';

export async function buildTemplateCommand(ctx: CliContext, templateDir: string): Promise<number> {
  const result = await compileTemplate(templateDir);

  ctx.out.info(`compiled ${result.sourcePath} → ${result.outputPath} (${String(result.bytes)} bytes)`);

  return EXIT.ok;
}
