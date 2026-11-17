import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, type Template, type TemplatePlugin } from '@mailroll/core';
import { isEnoent } from '../fs/is-enoent';

const PLUGIN_FILES = ['code/plugin.ts', 'code/plugin.mts', 'code/plugin.js', 'code/plugin.mjs'] as const;

export async function loadTemplatePlugin(template: Template): Promise<TemplatePlugin> {
  const path = await findPluginFile(template.dir);
  const mod = (await import(pathToFileURL(path).href)) as { readonly default?: unknown };

  if (!isTemplatePlugin(mod.default)) {
    throw new ConfigError(
      `template plugin at ${path} must "export default" definePlugin(...) (an object with a prepare function)`,
    );
  }

  return mod.default;
}

function isTemplatePlugin(value: unknown): value is TemplatePlugin {
  return typeof value === 'object' && value !== null && 'prepare' in value && typeof value.prepare === 'function';
}

async function findPluginFile(templateDir: string): Promise<string> {
  for (const candidate of PLUGIN_FILES) {
    const path = resolve(templateDir, candidate);

    if (await exists(path)) {
      return path;
    }
  }

  throw new ConfigError(`template at ${templateDir} has no plugin (expected one of: ${PLUGIN_FILES.join(', ')})`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }

    throw error;
  }
}
