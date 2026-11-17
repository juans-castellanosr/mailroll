import { type FileHandle, open } from 'node:fs/promises';
import { errorCode } from './error-code';
import { flushToDisk } from './flush-to-disk';

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');

  try {
    await flushDirectoryHandle(handle);
  } finally {
    await handle.close();
  }
}

async function flushDirectoryHandle(handle: FileHandle): Promise<void> {
  try {
    await flushToDisk(handle);
  } catch (error) {
    if (isDirectoryFlushRefusedByWindows(error)) {
      return;
    }

    throw error;
  }
}

function isDirectoryFlushRefusedByWindows(error: unknown): boolean {
  return process.platform === 'win32' && errorCode(error) === 'EPERM';
}
