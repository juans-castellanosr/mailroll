import { basename, join } from 'node:path';
import { type CcPolicy, ConfigError, type EmailAddress, normalizeEmail, type Template } from '@mailroll/core';
import { formatZodError } from '../config/format-zod-error';
import { templateConfigSchema } from '../config/template.schema';
import { readJson } from './read-json';

export async function loadTemplate(campaignId: string, templateDir: string): Promise<Template> {
  const configPath = join(templateDir, 'config', 'template.config.json');
  const parsed = templateConfigSchema.safeParse(await readJson(configPath));

  if (!parsed.success) {
    throw new ConfigError(`invalid template config ${configPath}: ${formatZodError(parsed.error)}`);
  }

  const cfg = parsed.data;
  const cc = cfg.cc !== undefined ? parseDefaultCc(cfg.cc, cfg.ccPolicy, configPath) : undefined;

  return {
    id: basename(templateDir),
    campaignId,
    ccPolicy: cfg.ccPolicy,
    connectionIds: cfg.connectionIds,
    dir: templateDir,
    dataDir: join(templateDir, 'data'),
    stateDir: join(templateDir, '.state'),
    assetsDir: join(templateDir, 'view', 'assets'),
    compiledHtmlPath: join(templateDir, 'view', 'compiled.html'),
    context: cfg.context,
    ...(cfg.subjectTemplate !== undefined ? { subjectTemplate: cfg.subjectTemplate } : {}),
    ...(cfg.pacing !== undefined ? { pacing: cfg.pacing } : {}),
    ...(cfg.saveToSentItems !== undefined ? { saveToSentItems: cfg.saveToSentItems } : {}),
    ...(cc !== undefined ? { cc } : {}),
  };
}

function parseDefaultCc(cc: readonly EmailAddress[], ccPolicy: CcPolicy, configPath: string): readonly EmailAddress[] {
  if (ccPolicy === 'forbidden') {
    throw new ConfigError(`invalid template config ${configPath}: "cc" is set but ccPolicy is "forbidden"`);
  }

  const seen = new Set<string>();

  for (const address of cc) {
    const key = normalizeEmail(address);

    if (seen.has(key)) {
      throw new ConfigError(`invalid template config ${configPath}: cc "${address}" is listed twice`);
    }

    seen.add(key);
  }

  return cc;
}
