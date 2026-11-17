import { fsync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';

const fsyncDescriptor = promisify(fsync);

export function flushToDisk(handle: FileHandle): Promise<void> {
  return fsyncDescriptor(handle.fd);
}
