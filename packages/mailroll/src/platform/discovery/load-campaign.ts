import { join } from 'node:path';
import { type Campaign, ConfigError } from '@mailroll/core';
import { campaignConfigSchema } from '../config/campaign.schema';
import { safeSegment } from '../config/connection-key';
import { formatZodError } from '../config/format-zod-error';
import { listDirs } from './list-dirs';
import { loadConnections } from './load-connections';
import { loadTemplate } from './load-template';
import { readJson } from './read-json';

export async function loadCampaign(campaignsRoot: string, group: string, name: string): Promise<Campaign> {
  const dir = join(campaignsRoot, group, name);
  const id = `${group}/${name}`;

  const parsed = campaignConfigSchema.safeParse(await readJson(join(dir, 'campaign.config.json')));

  if (!parsed.success) {
    throw new ConfigError(`invalid campaign config in ${dir}: ${formatZodError(parsed.error)}`);
  }

  const connections = await loadConnections(join(dir, 'connections'));

  const ids = new Set<string>();
  const keys = new Set<string>();

  for (const connection of connections) {
    if (ids.has(connection.id)) {
      throw new ConfigError(`duplicate connection id "${connection.id}" in campaign "${id}"`);
    }

    ids.add(connection.id);

    const key = safeSegment(connection.id);

    if (keys.has(key)) {
      throw new ConfigError(
        `connection id "${connection.id}" collides with another after normalization; use a distinct id`,
      );
    }

    keys.add(key);
  }

  const templatesDir = join(dir, 'templates');
  const templates = await Promise.all(
    (await listDirs(templatesDir)).map((t) => loadTemplate(id, join(templatesDir, t))),
  );

  const connectionIds = new Set(connections.map((c) => c.id));

  for (const template of templates) {
    for (const cid of template.connectionIds) {
      if (!connectionIds.has(cid)) {
        throw new ConfigError(`template "${template.id}" references unknown connection "${cid}"`);
      }
    }
  }

  return { id, displayName: parsed.data.displayName, connections, templates };
}
