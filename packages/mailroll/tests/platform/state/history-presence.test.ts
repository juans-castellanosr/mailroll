import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upgradeTemplateState } from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';
import { confirmUpgrade, inspectHistory } from '../../../src/platform/state/history-presence';
import { fixture, type ListFiles, stageList } from '../../support/state-v1-fixtures';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-presence-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const V2_SNAPSHOT = `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: 'T0' })}\n`;

describe('classifying a list history', () => {
  it.each([
    ['no files', {}, 'none'],
    ['an empty v1 journal only', { journal: '' }, 'none'],
    ['a v1 journal only', { journal: fixture('journal-mixed.jsonl') }, 'v1'],
    ['a v1 snapshot', { snapshot: fixture('snapshot.json') }, 'v1'],
    [
      'a v1 snapshot and journal',
      { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') },
      'v1',
    ],
    ['a v2 snapshot', { snapshot: V2_SNAPSHOT }, 'v2'],
    ['a v2 snapshot and journal', { snapshot: V2_SNAPSHOT, journal: `${JOURNAL_HEADER_LINE}\n` }, 'v2'],
    [
      'a v2 snapshot next to a leftover v1 journal',
      { snapshot: V2_SNAPSHOT, journal: fixture('journal-mixed.jsonl') },
      'v2',
    ],
    ['a v2 snapshot next to an empty v1 journal', { snapshot: V2_SNAPSHOT, journal: '' }, 'v2'],
  ] satisfies [string, ListFiles, string][])('%s → %s', async (_label, files, presence) => {
    const list = stageList(root, files);

    expect((await inspectHistory(list.snapshotPath)).presence).toBe(presence);
  });
});

describe('confirming that a run upgraded a list', () => {
  async function upgrade(files: ListFiles): Promise<{ readonly statePath: string; readonly snapshotPath: string }> {
    const list = stageList(root, files);
    const store = new FileStateStore();
    const lock = await store.lock(list.template);

    try {
      await store.compact(list.template, upgradeTemplateState(await store.load(list.template)));
    } finally {
      await lock.release();
    }

    return { statePath: list.snapshotPath, snapshotPath: list.snapshotPath };
  }

  it('confirms a completed upgrade and lists the backups found on disk', async () => {
    const files = { snapshot: fixture('snapshot.json'), journal: fixture('journal-mixed.jsonl') };
    const before = await inspectHistory(stageList(root, files).snapshotPath);
    const { statePath } = await upgrade(files);

    expect(await confirmUpgrade(statePath, before)).toEqual({
      upgraded: true,
      backups: [`${statePath}.v1-backup`, `${statePath}l.v1-backup`],
    });
  });

  it('confirms a journal-only upgrade with only the journal backup', async () => {
    const files = { journal: fixture('journal-mixed.jsonl') };
    const { statePath } = await upgrade(files);

    expect(await confirmUpgrade(statePath, { presence: 'v1', v1Snapshot: false })).toEqual({
      upgraded: true,
      backups: [`${statePath}l.v1-backup`],
    });
  });

  it('does not confirm when the snapshot backup is missing', async () => {
    const { statePath } = await upgrade({ snapshot: fixture('snapshot.json') });

    rmSync(`${statePath}.v1-backup`);

    expect(await confirmUpgrade(statePath, { presence: 'v1', v1Snapshot: true })).toEqual({ upgraded: false });
  });

  it('does not confirm while the history is still v1', async () => {
    const list = stageList(root, { snapshot: fixture('snapshot.json') });

    expect(await confirmUpgrade(list.snapshotPath, { presence: 'v1', v1Snapshot: true })).toEqual({ upgraded: false });
  });

  it('never reports an upgrade for a history that was not v1 before', async () => {
    const list = stageList(root, { snapshot: V2_SNAPSHOT });

    writeFileSync(`${list.snapshotPath}.v1-backup`, 'from an earlier run');

    expect(await confirmUpgrade(list.snapshotPath, { presence: 'v2', v1Snapshot: false })).toEqual({ upgraded: false });
    expect(await confirmUpgrade(list.snapshotPath, { presence: 'none', v1Snapshot: false })).toEqual({
      upgraded: false,
    });
  });
});
