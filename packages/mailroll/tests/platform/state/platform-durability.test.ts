import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type RecipientJournalEntry, upgradeTemplateState } from '@mailroll/core';
import { errorCode } from '../../../src/platform/fs/error-code';
import {
  appendDurably,
  createFile,
  moveFile,
  replaceFile,
  syncDirectory,
  truncateDurably,
} from '../../../src/platform/state/durable-files';
import { acquireFileLock } from '../../../src/platform/state/file-lock';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { ChildRun, stopAllChildren } from '../../support/concurrency/child-process';
import { expectPrivateFile } from '../../support/private-file';
import { asWriter } from '../../support/write-access';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';
import { fixture, listTemplate, stageList } from '../../support/state-v1-fixtures';
import { localPidSpace } from '../../support/local-pid-space';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-platform-'));
});
afterEach(async () => {
  await stopAllChildren();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function onThisPlatform<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = errorCode(error) ?? 'no code';
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`${operation} failed on ${process.platform} (${code}): ${message}`, { cause: error });
  }
}

const CHILD_PROCESS_TEST_MS = 60_000;

function lockedBy(child: ChildRun): Promise<number> {
  return Promise.race([
    child.pid,
    child.done.then((done) => {
      throw new Error(`the child process never took the lock on ${process.platform}: ${done.detail}`);
    }),
  ]);
}

async function withReaderOn<T>(path: string, work: () => Promise<T>): Promise<T> {
  const reader: FileHandle = await open(path, 'r');

  try {
    return await work();
  } finally {
    await reader.close();
  }
}

const MARK: RecipientJournalEntry = { email: 'nobody@example.com', released: { at: 'T9' } };

describe(`durable history operations on ${process.platform}`, () => {
  it('syncs a directory', async () => {
    await onThisPlatform('directory fsync', () => syncDirectory(root));
  });

  it('replaces a file atomically', async () => {
    const path = join(mkdtempSync(join(root, 'replace-')), 'list.json');

    await onThisPlatform('atomic replace', () => replaceFile(path, 'one'));
    await onThisPlatform('atomic replace over an existing file', () => replaceFile(path, 'two'));

    expect(readFileSync(path, 'utf8')).toBe('two');
    expectPrivateFile(path);
  });

  it('creates a file without ever overwriting one (hard link)', async () => {
    const path = join(mkdtempSync(join(root, 'create-')), 'list.json.v1-backup');

    expect(await onThisPlatform('exclusive create', () => createFile(path, 'original'))).toBe('created');
    expect(await onThisPlatform('exclusive create over an existing file', () => createFile(path, 'other'))).toBe(
      'exists',
    );
    expect(readFileSync(path, 'utf8')).toBe('original');
  });

  it('moves a file without ever overwriting the target (hard link, then remove)', async () => {
    const dir = mkdtempSync(join(root, 'move-'));

    writeFileSync(join(dir, 'a'), 'a');
    writeFileSync(join(dir, 'b'), 'b');
    writeFileSync(join(dir, 'c'), 'c');

    expect(await onThisPlatform('no-clobber move', () => moveFile(join(dir, 'a'), join(dir, 'moved')))).toBe('created');
    expect(
      await onThisPlatform('no-clobber move onto an existing file', () => moveFile(join(dir, 'b'), join(dir, 'c'))),
    ).toBe('exists');
    expect(readFileSync(join(dir, 'moved'), 'utf8')).toBe('a');
    expect(readFileSync(join(dir, 'c'), 'utf8')).toBe('c');
  });

  it('appends to and truncates an existing file durably, and never creates a missing one', async () => {
    const path = join(mkdtempSync(join(root, 'append-')), 'list.jsonl');

    writeFileSync(path, 'ab');

    await onThisPlatform('durable append', () => appendDurably(path, 'c'));
    await onThisPlatform('durable truncate', () => truncateDurably(path, 2));

    expect(readFileSync(path, 'utf8')).toBe('ab');
    await expect(
      appendDurably(`${path}.missing`, 'x'),
      `append to a missing file on ${process.platform}`,
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes, refuses and releases a list lock', async () => {
    const path = join(mkdtempSync(join(root, 'lock-')), 'list.json.lock');
    const lock = await onThisPlatform('lock acquire', () => acquireFileLock(path, 'the list'));

    await expect(acquireFileLock(path, 'the list'), `second lock on ${process.platform}`).rejects.toThrow(
      /in use by another run/,
    );
    await onThisPlatform('lock release', () => lock.release());
    await onThisPlatform('lock acquire after release', async () => (await acquireFileLock(path, 'the list')).release());
  });

  it('keeps a list lock exclusive between two processes', { timeout: CHILD_PROCESS_TEST_MS }, async () => {
    const path = join(mkdtempSync(join(root, 'cross-')), 'list.json.lock');
    const holder = ChildRun.start({ kind: 'lock-and-hold', lockPath: path });
    const pid = await lockedBy(holder);

    await expect(
      acquireFileLock(path, 'the list'),
      `lock held by another process on ${process.platform}`,
    ).rejects.toThrow(new RegExp(`in use by another run \\(process ${String(pid)} `));

    holder.go('release');

    expect(await holder.done).toMatchObject({ ok: true, detail: 'released' });
    await onThisPlatform('lock acquire after another process released it', async () =>
      (await acquireFileLock(path, 'the list')).release(),
    );
  });

  it('recovers the lock of a process that has really exited', { timeout: CHILD_PROCESS_TEST_MS }, async () => {
    const dir = mkdtempSync(join(root, 'orphan-'));
    const path = join(dir, 'list.json.lock');
    const orphaner = ChildRun.start({ kind: 'lock-and-exit', lockPath: path });
    const pid = await lockedBy(orphaner);

    await orphaner.exited();

    const lock = await onThisPlatform('recovery of an orphaned lock', () => acquireFileLock(path, 'the list'));

    expect(lock.recoveredFrom?.pid).toBe(pid);
    expect(readdirSync(dir)).toEqual(['list.json.lock']);
    await onThisPlatform('release of a recovered lock', () => lock.release());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('recovers, releases and takes again a lock that another reader has open', async () => {
    const dir = mkdtempSync(join(root, 'reader-'));
    const path = join(dir, 'list.json.lock');

    writeFileSync(
      path,
      JSON.stringify({
        pid: 2 ** 22 + 11,
        host: hostname(),
        startedAt: 'T0',
        token: 'dead',
        pidSpace: await localPidSpace(),
      }),
    );

    const recovered = await withReaderOn(path, () =>
      onThisPlatform('rename and rm of a stale lock while a reader has it open', () =>
        acquireFileLock(path, 'the list'),
      ),
    );

    expect(recovered.recoveredFrom?.startedAt).toBe('T0');

    await withReaderOn(path, async () => {
      await onThisPlatform('rm of a released lock while a reader has it open', () => recovered.release());
      await onThisPlatform('link onto the name of a lock removed while a reader has it open', async () =>
        (await acquireFileLock(path, 'the list')).release(),
      );
    });

    expect(readdirSync(dir)).toEqual([]);
  });

  it('creates nested state folders for a new list', async () => {
    const statePath = join(root, 'nested-campaign', '.state', 'deep', 'list.json');

    const template = listTemplate(statePath);
    const store = new FileStateStore();

    await onThisPlatform('first write of a new list', () =>
      asWriter(store, template, () => store.append(template, MARK)),
    );

    expect(readFileSync(`${statePath}l`, 'utf8')).toBe(`${JOURNAL_HEADER_LINE}\n${JSON.stringify(MARK)}\n`);
    expectPrivateFile(`${statePath}l`);
  });

  it('upgrades a v1 history with its backups', async () => {
    const files = { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') };
    const list = stageList(root, files);
    const expected = upgradeTemplateState(await new FileStateStore().load(list.template));
    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    await store.load(list.template);

    try {
      await onThisPlatform('v1 → v2 upgrade', () => store.append(list.template, MARK));
    } finally {
      await lock.release();
    }

    expect(await new FileStateStore().load(list.template)).toEqual(expected);
    expect(readFileSync(`${list.snapshotPath}.v1-backup`, 'utf8')).toBe(files.snapshot);
    expect(readFileSync(`${list.journalPath}.v1-backup`, 'utf8')).toBe(files.journal);
  });

  it('repairs a torn journal with text outside ASCII without losing a complete line', async () => {
    const complete = `${JOURNAL_HEADER_LINE}\n{"email":"josé@x.co","status":{"status":"sent","at":"T1","connectionId":"x","attemptId":"Á"}}\n`;
    const list = stageList(root, {
      snapshot: `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' })}\n`,
      journal: `${complete}{"email":"b@x.co","sta`,
    });

    const store = new FileStateStore();

    await onThisPlatform('torn tail repair', () =>
      asWriter(store, list.template, () => store.append(list.template, MARK)),
    );

    expect(readFileSync(list.journalPath, 'utf8')).toBe(`${complete}${JSON.stringify(MARK)}\n`);
  });

  it('finishes an upgrade left half-done (v2 snapshot next to the v1 journal)', async () => {
    const files = { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') };
    const list = stageList(root, files);
    const expected = upgradeTemplateState(await new FileStateStore().load(list.template));

    writeFileSync(list.snapshotPath, `${JSON.stringify(expected, null, 2)}\n`);

    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    await store.load(list.template);

    try {
      await onThisPlatform('recovery after an interrupted upgrade', () => store.append(list.template, MARK));
    } finally {
      await lock.release();
    }

    expect(await new FileStateStore().load(list.template)).toEqual(expected);
    expect(readFileSync(`${list.journalPath}.v1-backup`, 'utf8')).toBe(files.journal);
  });
});
