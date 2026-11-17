import { randomUUID } from 'node:crypto';
import { chmod, constants, type FileHandle, link, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode } from '../fs/error-code';
import { flushToDisk } from '../fs/flush-to-disk';
import { isEnoent } from '../fs/is-enoent';

export type Fence = () => Promise<void>;

const unfenced: Fence = () => Promise.resolve();

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

export async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }

    throw error;
  }
}

async function writeTemporary(path: string, content: string | Buffer): Promise<string> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);

  try {
    await handle.writeFile(content);
    await flushToDisk(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  }

  await handle.close();

  return tmp;
}

export async function replaceFile(
  path: string,
  content: string | Buffer,
  beforeReplacing: Fence = unfenced,
): Promise<void> {
  const tmp = await writeTemporary(path, content);

  try {
    await beforeReplacing();
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }

  await chmod(path, 0o600);
  await syncDirectory(dirname(path));
}

export type CreateOutcome = 'created' | 'exists';

export async function createFile(path: string, content: string | Buffer): Promise<CreateOutcome> {
  const tmp = await writeTemporary(path, content);

  try {
    await link(tmp, path);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return 'exists';
    }

    throw error;
  } finally {
    await rm(tmp, { force: true });
  }

  await syncDirectory(dirname(path));

  return 'created';
}

export async function moveFile(
  from: string,
  to: string,
  beforeRemovingSource: Fence = unfenced,
): Promise<CreateOutcome> {
  try {
    await link(from, to);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return 'exists';
    }

    throw error;
  }

  await syncDirectory(dirname(to));
  await beforeRemovingSource();
  await rm(from);
  await syncDirectory(dirname(from));

  return 'created';
}

export async function removeFile(path: string, beforeRemoving: Fence = unfenced): Promise<void> {
  await beforeRemoving();
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

export async function appendDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND);

  try {
    await handle.write(text);
    await flushToDisk(handle);
  } finally {
    await handle.close();
  }
}

export async function truncateDurably(path: string, length: number, beforeTruncating: Fence = unfenced): Promise<void> {
  const handle = await open(path, 'r+');

  try {
    await beforeTruncating();
    await handle.truncate(length);
    await flushToDisk(handle);
  } finally {
    await handle.close();
  }
}
