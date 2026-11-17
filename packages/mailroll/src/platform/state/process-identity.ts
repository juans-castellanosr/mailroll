import { readFile, stat } from 'node:fs/promises';
import { errorCode } from '../fs/error-code';

export type PidSpace =
  { readonly kind: 'known'; readonly id: string } | { readonly kind: 'unknown'; readonly reason: string };

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const PID_NAMESPACE_PATH = '/proc/self/ns/pid';
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINUX_PID_SPACE = /^linux:([0-9a-f-]{36}):(\d+:\d+)$/;
const SINGLE_PID_SPACE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'win32']);

export async function readPidSpace(platform: NodeJS.Platform, host: string): Promise<PidSpace> {
  if (platform === 'linux') {
    return readLinuxPidSpace();
  }

  if (SINGLE_PID_SPACE_PLATFORMS.has(platform)) {
    return { kind: 'known', id: `${platform}:${host}` };
  }

  return { kind: 'unknown', reason: `mailroll cannot tell process spaces apart on ${platform}` };
}

async function readLinuxPidSpace(): Promise<PidSpace> {
  let bootId: string;
  let namespace: string;

  try {
    bootId = (await readFile(BOOT_ID_PATH, 'utf8')).trim().toLowerCase();
  } catch (error) {
    return unreadable(BOOT_ID_PATH, error);
  }

  if (!BOOT_ID.test(bootId)) {
    return { kind: 'unknown', reason: `${BOOT_ID_PATH} does not hold a boot id` };
  }

  try {
    const stats = await stat(PID_NAMESPACE_PATH, { bigint: true });

    namespace = `${String(stats.dev)}:${String(stats.ino)}`;
  } catch (error) {
    return unreadable(PID_NAMESPACE_PATH, error);
  }

  return { kind: 'known', id: `linux:${bootId}:${namespace}` };
}

export function describePidSpaceDifference(recorded: string, own: string): string {
  const theirs = linuxPartsOf(recorded);
  const ours = linuxPartsOf(own);

  if (theirs === undefined || ours === undefined) {
    return `it was written in process space ${recorded}, and this run is in ${own}: by another machine, container or operating system with the same host name`;
  }

  if (theirs.bootId !== ours.bootId) {
    return `it was written during another boot of a Linux kernel (boot id ${theirs.bootId}, PID namespace ${theirs.namespace}; this run: boot id ${ours.bootId}, PID namespace ${ours.namespace}): this machine has restarted since, or it was written by another machine with the same host name`;
  }

  return `it was written in another PID namespace of this machine (PID namespace ${theirs.namespace}; this run: PID namespace ${ours.namespace}, both in boot ${ours.bootId}): by another container, by a container that has been restarted since, or by the host outside the containers`;
}

interface LinuxParts {
  readonly bootId: string;
  readonly namespace: string;
}

function linuxPartsOf(id: string): LinuxParts | undefined {
  const match = LINUX_PID_SPACE.exec(id);
  const bootId = match?.[1];
  const namespace = match?.[2];

  return bootId === undefined || namespace === undefined ? undefined : { bootId, namespace };
}

function unreadable(path: string, error: unknown): PidSpace {
  const detail = errorCode(error) ?? (error instanceof Error ? error.message : 'unknown failure');

  return { kind: 'unknown', reason: `${path} could not be read (${detail})` };
}
