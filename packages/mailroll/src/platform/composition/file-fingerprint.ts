import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigError } from '@mailroll/core';

export async function fileFingerprint(path: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (error) {
    throw new ConfigError(`cannot read data file ${path}`, { cause: error });
  }
}
