import { hostname } from 'node:os';
import { readPidSpace } from '../../src/platform/state/process-identity';

export async function localPidSpace(): Promise<string> {
  const space = await readPidSpace(process.platform, hostname());

  if (space.kind === 'unknown') {
    throw new Error(`these tests need the process space of this machine, which cannot be read: ${space.reason}`);
  }

  return space.id;
}
