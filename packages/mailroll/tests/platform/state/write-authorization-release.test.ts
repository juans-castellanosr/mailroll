import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type RecipientJournalEntry, upgradeTemplateState } from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';
import { interleaver } from '../../support/concurrency/fs-interleave';
import { stageList } from '../../support/state-v1-fixtures';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const { interleaver: hooks } = await import('../../support/concurrency/fs-interleave');

  return { ...actual, open: hooks.wrap('open', 1, actual.open) };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-release-'));
  interleaver.reset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sent = (email: string): RecipientJournalEntry => ({
  email,
  status: { status: 'sent', at: 'T1', connectionId: 'outlook-1' },
});

describe('releasing the lock while an authorized write is still running', () => {
  it('keeps the lock file until that write ends, and a later lock of the same store prepares the journal again', async () => {
    const list = stageList(root, {});
    const lockPath = `${list.snapshotPath}.lock`;
    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    await store.load(list.template);

    const paused = interleaver.pauseBefore('writer', 'open', 1, (file) => file.endsWith('.tmp'));
    const writing = interleaver.as('writer', () => store.append(list.template, sent('a@x.co')));

    await interleaver.reached(paused);

    const releasing = lock.release();
    const lockKeptDuringTheWrite = existsSync(lockPath);

    interleaver.release(paused);
    await writing;
    await releasing;

    expect(lockKeptDuringTheWrite).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    appendFileSync(list.journalPath, '{"email":"torn@x.co","sta');

    const again = await store.lock(list.template);

    await store.load(list.template);
    await store.append(list.template, sent('b@x.co'));
    await again.release();

    expect(readFileSync(list.journalPath, 'utf8')).toBe(
      `${JOURNAL_HEADER_LINE}\n${JSON.stringify(sent('a@x.co'))}\n${JSON.stringify(sent('b@x.co'))}\n`,
    );
    expect(Object.keys(upgradeTemplateState(await new FileStateStore().load(list.template)).recipients)).toEqual([
      'a@x.co',
      'b@x.co',
    ]);
  });
});

describe('a lock file that cannot be read to check who owns it', () => {
  it('refuses the write with a ConfigError, writes nothing, and keeps refusing after the file is readable again', async () => {
    const list = stageList(root, {
      snapshot: `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' })}\n`,
    });
    const lockPath = `${list.snapshotPath}.lock`;
    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    await store.load(list.template);

    const ours = readFileSync(lockPath, 'utf8');

    rmSync(lockPath);
    mkdirSync(lockPath);

    const before = readFileSync(list.snapshotPath, 'utf8');
    const failure = await store.append(list.template, sent('a@x.co')).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure instanceof Error ? failure.message : '').toMatch(
      /\(its lock file could not be read to confirm this run still owns it\); nothing was written/,
    );
    expect(readFileSync(list.snapshotPath, 'utf8')).toBe(before);
    expect(existsSync(list.journalPath)).toBe(false);

    rmSync(lockPath, { recursive: true });
    writeFileSync(lockPath, ours);

    await expect(store.append(list.template, sent('a@x.co'))).rejects.toThrow(ConfigError);
    await lock.release();
    expect(existsSync(list.journalPath)).toBe(false);
  });
});
