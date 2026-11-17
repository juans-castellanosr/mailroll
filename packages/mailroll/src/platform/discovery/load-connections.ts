import { isEnoent } from '../fs/is-enoent';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, type Connection } from '@mailroll/core';
import { connectionConfigSchema } from '../config/connection.schema';
import { formatZodError } from '../config/format-zod-error';
import { readJson } from './read-json';

export async function loadConnections(connectionsDir: string): Promise<Connection[]> {
  let files: string[];

  try {
    files = (await readdir(connectionsDir)).filter((f) => f.endsWith('.json')).sort();
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }

  const connections: Connection[] = [];

  for (const file of files) {
    const path = join(connectionsDir, file);
    const parsed = connectionConfigSchema.safeParse(await readJson(path));

    if (!parsed.success) {
      throw new ConfigError(`invalid connection ${path}: ${formatZodError(parsed.error)}`);
    }

    connections.push({
      id: parsed.data.id,
      kind: parsed.data.kind,
      mailbox: parsed.data.mailbox,
      ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
      ...(parsed.data.settings !== undefined ? { settings: parsed.data.settings } : {}),
    });
  }

  return connections;
}
