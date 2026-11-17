import { join } from 'node:path';
import { ConfigError, type ResolvedTemplate, type Template } from '@mailroll/core';
import { safeSegment } from '../config/connection-key';
import { listDataFiles } from '../discovery/list-data-files';

export const DEFAULT_DATA_FILE = 'recipients.csv';

export function resolveTemplate(template: Template, dataFile: string): ResolvedTemplate {
  const stem = safeSegment(dataFile.replace(/\.csv$/i, ''));

  if (stem.length === 0) {
    throw new ConfigError(
      `data file "${dataFile}" of template "${template.id}" needs at least one letter or digit in its name (it names the send-state file)`,
    );
  }

  return {
    ...template,
    dataFile,
    dataPath: join(template.dataDir, dataFile),
    statePath: join(template.stateDir, `${stem}.json`),
  };
}

export async function listTemplateDataFiles(template: Template): Promise<string[]> {
  const files = await listDataFiles(template.dataDir);
  const owners = new Map<string, string>();

  for (const file of files) {
    const { statePath } = resolveTemplate(template, file);
    const other = owners.get(statePath);

    if (other !== undefined) {
      throw new ConfigError(
        `CSV files "${other}" and "${file}" of template "${template.id}" map to the same send-state file (${statePath}); rename one so their histories stay separate`,
      );
    }

    owners.set(statePath, file);
  }

  return files;
}

export async function resolveDataFile(template: Template, requested: string | undefined): Promise<string> {
  const files = await listTemplateDataFiles(template);

  if (requested !== undefined) {
    if (!files.includes(requested)) {
      throw new ConfigError(`data file "${requested}" not found in template "${template.id}"`);
    }

    return requested;
  }

  if (files.includes(DEFAULT_DATA_FILE)) {
    return DEFAULT_DATA_FILE;
  }

  const [first, ...rest] = files;

  if (first === undefined) {
    throw new ConfigError(`template "${template.id}" has no CSV file in its data/ folder`);
  }

  if (rest.length > 0) {
    throw new ConfigError(
      `template "${template.id}" has multiple CSV files; choose one with --data (${files.join(', ')})`,
    );
  }

  return first;
}
