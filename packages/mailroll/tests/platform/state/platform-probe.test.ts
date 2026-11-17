import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chmod, type FileHandle, link, open, rename, rm } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { errorCode } from '../../../src/platform/fs/error-code';
import { flushToDisk } from '../../../src/platform/fs/flush-to-disk';
import { recordEvidence } from '../../support/concurrency/evidence';

type Outcome =
  | { readonly ok: true; readonly value?: string | number | boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

const EVIDENCE_PREFIX = 'MAILROLL_PLATFORM_EVIDENCE';

let root: string;
const readers: FileHandle[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-probe-'));
});
afterAll(async () => {
  await Promise.all(readers.splice(0).map((handle) => handle.close().catch(() => undefined)));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function failure(error: unknown): Outcome {
  return {
    ok: false,
    code: errorCode(error) ?? 'no code',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function observe(work: () => Promise<string | number | boolean | undefined>): Promise<Outcome> {
  try {
    const value = await work();

    return value === undefined ? { ok: true } : { ok: true, value };
  } catch (error) {
    return failure(error);
  }
}

async function openReader(path: string): Promise<FileHandle> {
  const handle = await open(path, 'r');

  readers.push(handle);

  return handle;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });

  if (child.error !== undefined) {
    throw child.error;
  }

  return child.pid;
}

async function directoryOutcomes(): Promise<Record<string, Outcome>> {
  const dir = mkdtempSync(join(root, 'dir-'));
  let handle: FileHandle;

  try {
    handle = await open(dir, 'r');
  } catch (error) {
    return {
      'directory open (r)': failure(error),
      'directory fsync': { ok: false, code: 'not run', message: 'the directory could not be opened' },
    };
  }

  try {
    const synced = await outcomeOf(() => flushToDisk(handle));

    return { 'directory open (r)': { ok: true }, 'directory fsync': synced };
  } finally {
    await handle.close();
  }
}

async function outcomeOf(work: () => Promise<unknown>): Promise<Outcome> {
  return observe(async () => {
    await work();

    return undefined;
  });
}

function listedIn(dir: string, name: string): Outcome {
  try {
    return { ok: true, value: readdirSync(dir).includes(name) };
  } catch (error) {
    return failure(error);
  }
}

async function renameAwayFromOpenReader(): Promise<Outcome> {
  const dir = mkdtempSync(join(root, 'rename-'));
  const lock = join(dir, 'list.json.lock');

  writeFileSync(lock, 'old');
  await openReader(lock);

  return outcomeOf(() => rename(lock, join(dir, 'list.json.lock.stale')));
}

async function removeThenLinkSameNameUnderOpenReader(): Promise<Record<string, Outcome>> {
  const dir = mkdtempSync(join(root, 'same-name-'));
  const name = 'list.json.lock';
  const lock = join(dir, name);
  const fresh = join(dir, 'fresh');

  writeFileSync(lock, 'old');
  writeFileSync(fresh, 'new');
  await openReader(lock);

  const removed = await outcomeOf(() => rm(lock));
  const stillListed = listedIn(dir, name);
  const relinked = await outcomeOf(() => link(fresh, lock));

  return {
    'rm while a reader is open': removed,
    'removed name still listed while the reader is open': stillListed,
    'link onto that same name while the old reader is open': relinked,
  };
}

async function renameOntoOpenTarget(): Promise<Outcome> {
  const dir = mkdtempSync(join(root, 'replace-'));
  const target = join(dir, 'list.json');
  const source = join(dir, 'list.json.tmp');

  writeFileSync(target, 'old');
  writeFileSync(source, 'new');
  await openReader(target);

  return outcomeOf(() => rename(source, target));
}

async function linkFromOpenSource(): Promise<Outcome> {
  const dir = mkdtempSync(join(root, 'link-'));
  const source = join(dir, 'source.tmp');

  writeFileSync(source, 'x');
  await openReader(source);

  return outcomeOf(() => link(source, join(dir, 'target')));
}

async function chmodOutcome(): Promise<Outcome> {
  const path = join(mkdtempSync(join(root, 'mode-')), 'list.json');

  writeFileSync(path, 'x');

  return observe(async () => {
    await chmod(path, 0o600);

    return `0o${(statSync(path).mode & 0o777).toString(8)}`;
  });
}

function deadProcessOutcome(): Promise<Outcome> {
  return observe(() => {
    const pid = deadPid();

    process.kill(pid, 0);

    return Promise.resolve(`process ${String(pid)} still answers`);
  });
}

describe(`evidence of the raw file-system primitives on ${process.platform}, recorded and never judged`, () => {
  it('records how this platform behaves, on stderr because the reporter hides console output of passing tests in CI', async () => {
    const evidence = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: release(),
      outcomes: {
        ...(await directoryOutcomes()),
        'rename away from a name a reader has open': await renameAwayFromOpenReader(),
        ...(await removeThenLinkSameNameUnderOpenReader()),
        'rename onto a target a reader has open': await renameOntoOpenTarget(),
        'link from a source that is open': await linkFromOpenSource(),
        'chmod 0600, then the reported mode': await chmodOutcome(),
        'signal 0 to a process that has exited': await deadProcessOutcome(),
      },
    };

    process.stderr.write(`${EVIDENCE_PREFIX} ${JSON.stringify(evidence)}\n`);
    recordEvidence(`platform-probe-${process.platform}-${process.version}`, evidence);
  });
});
