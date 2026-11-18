import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { open, rename, rm } from 'node:fs/promises';
import { ConfigError, type StateLock } from '@mailroll/core';
import { errorCode } from '../fs/error-code';
import { createFile } from './durable-files';
import { describePidSpaceDifference, type PidSpace, readPidSpace } from './process-identity';

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
}

interface LockRecord extends LockOwner {
  readonly token?: string;
  readonly pidSpace?: string;
}

interface OwnRecord extends LockOwner {
  readonly token: string;
  readonly pidSpace?: string;
}

interface Contender {
  readonly record: OwnRecord;
  readonly pidSpace: PidSpace;
}

type OwnerState =
  | { readonly kind: 'running' }
  | { readonly kind: 'ended' }
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'unverifiable'; readonly reason: string };

export interface AcquiredLock extends StateLock {
  readonly recoveredFrom?: LockOwner;
}

type Inspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly identity: string; readonly record: LockRecord | undefined };

type Present = Extract<Inspection, { readonly kind: 'present' }>;

interface Ownership {
  readonly token: string;
  readonly identity: string;
}

type RecoveryOutcome = { readonly kind: 'acquired'; readonly owned: Ownership } | { readonly kind: 'retry' };

interface Acquisition {
  readonly path: string;
  readonly owned: Ownership;
}

const ATTEMPTS = 3;
const REMEDY =
  'Make sure that no mailroll run and no lock recovery is active on this list, on every machine that shares this folder, before running again';
const acquisitions = new WeakMap<StateLock, Acquisition>();

export async function isLockStillHeld(lock: StateLock): Promise<boolean> {
  const acquisition = acquisitions.get(lock);

  if (acquisition === undefined) {
    return false;
  }

  return holds(await inspect(acquisition.path), acquisition.owned);
}

export async function acquireFileLock(path: string, describe: string): Promise<AcquiredLock> {
  const host = hostname();
  const pidSpace = await readPidSpace(process.platform, host);
  const self: Contender = {
    record: {
      pid: process.pid,
      host,
      startedAt: new Date().toISOString(),
      token: randomUUID(),
      ...(pidSpace.kind === 'known' ? { pidSpace: pidSpace.id } : {}),
    },
    pidSpace,
  };
  let last: Inspection = { kind: 'absent' };

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const created = await tryCreate(path, self.record);

    if (created !== undefined) {
      return lockFor(path, created);
    }

    last = await inspect(path);

    if (last.kind === 'absent') {
      continue;
    }

    const stale = last.record;

    if (stale === undefined || stateOf(stale, self).kind !== 'ended') {
      break;
    }

    const recovery = await recover(path, describe, last, self);

    if (recovery.kind === 'acquired') {
      return lockFor(path, recovery.owned, ownerOf(stale));
    }
  }

  const state = last.kind === 'present' && last.record !== undefined ? stateOf(last.record, self) : undefined;

  if (state?.kind === 'ended') {
    throw new ConfigError(
      `${describe} could not be taken: the lock left by ${describeOwner(last)}, which is no longer running, kept changing while mailroll tried to recover it; try again`,
    );
  }

  if (state?.kind === 'unverifiable') {
    throw new ConfigError(
      `${describe} is in use by another run (${describeOwner(last)}), and mailroll cannot tell whether that process is still running: ${state.reason}. Wait for it to finish. Only once you are sure that it has ended, on every machine and container that shares this folder under the host name ${self.record.host}, and that no lock recovery is active on this list (${recoverPathFor(path)} does not exist), delete ${path}`,
    );
  }

  throw new ConfigError(
    `${describe} is in use by another run (${describeOwner(last)}). Wait for it to finish; if no run and no lock recovery is active on this list (${recoverPathFor(path)} does not exist), delete ${path}`,
  );
}

function recoverPathFor(path: string): string {
  return `${path}.recover`;
}

async function recover(path: string, describe: string, stale: Present, contender: Contender): Promise<RecoveryOutcome> {
  const marker = recoverPathFor(path);
  const self = contender.record;

  const markerOwned = await tryCreate(marker, self);

  if (markerOwned === undefined) {
    const blocker = await recoveryBlocked(path, describe, marker, contender);

    if (blocker === undefined) {
      return { kind: 'retry' };
    }

    throw blocker;
  }

  const outcome = await recoverUnderMarker(path, stale, self).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const markerFailure = await failureOf(removeIfHeld(marker, markerOwned));

  if (markerFailure === undefined) {
    if (!outcome.ok) {
      throw outcome.error;
    }

    return outcome.value;
  }

  const recovered = outcome.ok && outcome.value.kind === 'acquired' ? outcome.value.owned : undefined;
  const acquired = recovered !== undefined;
  const releaseFailure = recovered === undefined ? undefined : await failureOf(removeIfHeld(path, recovered));
  const causes = [
    ...(outcome.ok ? [] : [outcome.error]),
    markerFailure,
    ...(releaseFailure === undefined ? [] : [releaseFailure]),
  ];
  const lockState = !acquired
    ? 'the lock was not recovered'
    : releaseFailure === undefined
      ? `the lock it had just recovered was released again`
      : `the lock it had just recovered could not be released either and stays at ${path} until this process ends`;

  throw new ConfigError(
    `${describe}: could not remove ${marker}, and ${lockState}. Make sure that no mailroll run and no lock recovery is active on this list, on every machine that shares this folder; then delete ${marker}`,
    { cause: causes.length === 1 ? causes[0] : new AggregateError(causes) },
  );
}

async function recoverUnderMarker(path: string, stale: Present, self: OwnRecord): Promise<RecoveryOutcome> {
  const again = await inspect(path);

  if (again.kind === 'absent' || again.identity !== stale.identity || !sameRecord(again.record, stale.record)) {
    return { kind: 'retry' };
  }

  const aside = asidePathFor(path);

  try {
    await rename(path, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { kind: 'retry' };
    }

    throw error;
  }

  const moved = await inspect(aside);

  if (moved.kind !== 'present' || moved.identity !== again.identity || !sameRecord(moved.record, again.record)) {
    throw new ConfigError(
      `the lock ${path} was replaced while it was being recovered, which only happens if someone deleted it by hand during the recovery; nothing was deleted: ${keptDetail(aside, moved)}. ${REMEDY}`,
    );
  }

  await rm(aside, { force: true });

  const owned = await tryCreate(path, self);

  return owned === undefined ? { kind: 'retry' } : { kind: 'acquired', owned };
}

function asidePathFor(path: string): string {
  return `${path}.stale-${randomUUID()}`;
}

function keptDetail(aside: string, moved: Inspection): string {
  return moved.kind === 'absent'
    ? `the file moved to ${aside} has disappeared`
    : `the replacement is kept as ${aside}, and the run whose lock it is will stop at its next check`;
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;

    return undefined;
  } catch (error) {
    return error ?? new Error('unknown failure');
  }
}

async function recoveryBlocked(
  path: string,
  describe: string,
  marker: string,
  contender: Contender,
): Promise<ConfigError | undefined> {
  const current = await inspect(marker);

  if (current.kind === 'absent') {
    return undefined;
  }

  const recoverer = current.record;
  const state = recoverer === undefined ? undefined : stateOf(recoverer, contender);

  if (recoverer !== undefined && state?.kind === 'running') {
    return new ConfigError(
      `${describe} is being recovered by another run (process ${String(recoverer.pid)} on ${recoverer.host}, since ${recoverer.startedAt}); try again when it finishes. If that process is not a mailroll run (its process id may have been reused), make sure that no mailroll run and no lock recovery is active on this list, then delete ${marker}`,
    );
  }

  if (state?.kind === 'unverifiable') {
    return new ConfigError(
      `${describe} cannot be recovered: ${marker} shows that ${describeOwner(current)}, is recovering ${path} or stopped while doing so, and mailroll cannot tell whether that process is still running: ${state.reason}. If it is still running, try again when it finishes. Otherwise make sure that no mailroll run and no lock recovery is active on this list, on every machine and container that shares this folder under the host name ${contender.record.host}; then delete ${marker}, and delete ${path} too if the process that holds it is not running`,
    );
  }

  return new ConfigError(
    `${describe} cannot be recovered: an earlier recovery of ${path} did not finish and left ${marker} (${describeOwner(current)}). Make sure that no mailroll run and no lock recovery is active on this list, on every machine that shares this folder; then delete ${marker}, and delete ${path} too if the process that holds it is not running`,
  );
}

function describeOwner(inspection: Inspection): string {
  if (inspection.kind === 'absent') {
    return 'it changed hands while mailroll was trying to take it';
  }

  const record = inspection.record;

  return record === undefined
    ? 'an unknown process (unreadable lock file)'
    : `process ${String(record.pid)} on ${record.host}, since ${record.startedAt}`;
}

function stateOf(record: LockRecord, contender: Contender): OwnerState {
  if (record.host !== contender.record.host) {
    return { kind: 'elsewhere' };
  }

  const reason = unverifiableReason(record, contender.pidSpace);

  if (reason !== undefined) {
    return { kind: 'unverifiable', reason };
  }

  return isAlive(record.pid) ? { kind: 'running' } : { kind: 'ended' };
}

function unverifiableReason(record: LockRecord, own: PidSpace): string | undefined {
  if (record.pidSpace === undefined) {
    return 'it does not record the process space it was written in, as is the case for locks written by mailroll 0.1 and for files written by a run that could not read its own process space';
  }

  if (own.kind === 'unknown') {
    return `this run cannot read its own process space, because ${own.reason}`;
  }

  if (record.pidSpace !== own.id) {
    return describePidSpaceDifference(record.pidSpace, own.id);
  }

  return undefined;
}

function ownerOf(record: LockRecord): LockOwner {
  return { pid: record.pid, host: record.host, startedAt: record.startedAt };
}

function sameRecord(a: LockRecord | undefined, b: LockRecord | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }

  return (
    a.pid === b.pid &&
    a.host === b.host &&
    a.startedAt === b.startedAt &&
    a.token === b.token &&
    a.pidSpace === b.pidSpace
  );
}

function holds(inspection: Inspection, owned: Ownership): boolean {
  return (
    inspection.kind === 'present' && inspection.identity === owned.identity && inspection.record?.token === owned.token
  );
}

async function tryCreate(path: string, record: OwnRecord): Promise<Ownership | undefined> {
  try {
    if ((await createFile(path, JSON.stringify(record))) === 'exists') {
      return undefined;
    }

    return ownershipOf(await inspect(path), record.token);
  } catch (error) {
    const leftover = await failureOf(removeOwnLeftover(path, record.token));

    throw new ConfigError(
      leftover === undefined
        ? `could not create ${path}; nothing was left behind`
        : `could not create ${path}, and it may have been left behind: make sure that no mailroll run and no lock recovery is active on this list, then delete ${path}`,
      { cause: leftover === undefined ? error : new AggregateError([error, leftover]) },
    );
  }
}

async function inspect(path: string): Promise<Inspection> {
  let handle;

  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { kind: 'absent' };
    }

    throw error;
  }

  try {
    const stats = await handle.stat({ bigint: true });
    const text = await handle.readFile('utf8');

    return { kind: 'present', identity: `${String(stats.dev)}:${String(stats.ino)}`, record: parseRecord(text) };
  } finally {
    await handle.close();
  }
}

function parseRecord(text: string): LockRecord | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const pid: unknown = Reflect.get(parsed, 'pid');
  const host: unknown = Reflect.get(parsed, 'host');
  const startedAt: unknown = Reflect.get(parsed, 'startedAt');
  const token: unknown = Reflect.get(parsed, 'token');
  const pidSpace: unknown = Reflect.get(parsed, 'pidSpace');

  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== 'string' ||
    host === '' ||
    typeof startedAt !== 'string' ||
    !isOptionalText(token) ||
    !isOptionalText(pidSpace)
  ) {
    return undefined;
  }

  return {
    pid,
    host,
    startedAt,
    ...(token === undefined ? {} : { token }),
    ...(pidSpace === undefined ? {} : { pidSpace }),
  };
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value !== '');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function ownershipOf(inspection: Inspection, token: string): Ownership | undefined {
  return inspection.kind === 'present' && inspection.record?.token === token
    ? { token, identity: inspection.identity }
    : undefined;
}

async function removeOwnLeftover(path: string, token: string): Promise<void> {
  const owned = ownershipOf(await inspect(path), token);

  if (owned !== undefined) {
    await removeIfHeld(path, owned);
  }
}

async function removeIfHeld(path: string, owned: Ownership): Promise<void> {
  if (!holds(await inspect(path), owned)) {
    return;
  }

  const aside = asidePathFor(path);

  try {
    await rename(path, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }

    throw error;
  }

  const moved = await inspect(aside);

  if (holds(moved, owned)) {
    const leftover = await failureOf(rm(aside, { force: true }));

    if (leftover !== undefined) {
      throw new ConfigError(
        `${path} was released, but the copy it was moved to, ${aside}, could not be removed; mailroll never reads it, and it is safe to delete`,
        { cause: leftover },
      );
    }

    return;
  }

  throw new ConfigError(
    `${path} was replaced while this run was releasing its own lock, which only happens if someone deleted it by hand; nothing was deleted: ${keptDetail(aside, moved)}. ${REMEDY}`,
  );
}

function lockFor(path: string, owned: Ownership, recoveredFrom?: LockOwner): AcquiredLock {
  let released = false;
  let releasing: Promise<void> | undefined;
  const lock: AcquiredLock = {
    ...(recoveredFrom === undefined ? {} : { recoveredFrom }),
    release: (): Promise<void> => {
      if (released) {
        return Promise.resolve();
      }

      releasing ??= removeIfHeld(path, owned).then(
        () => {
          released = true;
        },
        (error: unknown) => {
          releasing = undefined;
          throw error;
        },
      );

      return releasing;
    },
  };

  acquisitions.set(lock, { path, owned });

  return lock;
}
