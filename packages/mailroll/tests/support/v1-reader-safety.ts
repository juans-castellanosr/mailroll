import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE } from '../../src/platform/state/history-format';
import { type FrozenV1Entry, FrozenV1FileStateStore } from './frozen-v1-file-state-store';
import { fixture, type StagedList, stageList } from './state-v1-fixtures';

const laterSend: FrozenV1Entry = {
  email: 'kim@example.com',
  status: { status: 'sent', at: '2026-01-15T12:00:00.000Z', connectionId: 'outlook-1' },
};

function filesOf(list: StagedList): Record<string, string> {
  const dir = dirname(list.snapshotPath);

  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(`${dir}/${name}`, 'utf8')]));
}

const v1List = (list: StagedList) => ({ id: list.template.id, statePath: list.snapshotPath });

export function describeV1ReaderSafety(root: () => string): void {
  const v1Snapshot = fixture('snapshot.json');
  const v1Event = fixture('journal-mixed.jsonl').split('\n')[0] ?? '';

  describe('the 0.1.0 reader (frozen copy) facing v2 history files', () => {
    it('stops at the v2 barrier a live run writes, and changes no file', async () => {
      const list = stageList(root(), { snapshot: v1Snapshot, journal: fixture('journal-mixed.jsonl') });
      const store = new FileStateStore();
      const lock = await store.lock(list.template);

      await store.load(list.template);

      await store.append(list.template, {
        email: 'kim@example.com',
        intent: { at: 'T9', connectionId: 'outlook-1', attemptId: 'A' },
      });
      await lock.release();

      const before = filesOf(list);

      await expect(new FrozenV1FileStateStore().load(v1List(list))).rejects.toThrow(/invalid state file/);
      expect(filesOf(list)).toEqual(before);
    });

    it('stops at line 1 when a v2 journal follows a v1 snapshot', async () => {
      const journal = `${JOURNAL_HEADER_LINE}\n${v1Event}\n`;
      const list = stageList(root(), { snapshot: v1Snapshot, journal });

      await expect(new FrozenV1FileStateStore().load(v1List(list))).rejects.toThrow(/\(line 1\)/);
      expect(filesOf(list)).toEqual({ 'list.json': v1Snapshot, 'list.jsonl': journal });
    });

    it('ignores a lone v2 header next to a v1 snapshot, and its own next load stops once it appends behind it', async () => {
      const list = stageList(root(), { snapshot: v1Snapshot, journal: `${JOURNAL_HEADER_LINE}\n` });
      const reader = new FrozenV1FileStateStore();
      const snapshotOnly = stageList(root(), { snapshot: v1Snapshot });

      expect(await reader.load(v1List(list))).toEqual(await reader.load(v1List(snapshotOnly)));

      await reader.append(v1List(list), laterSend);

      await expect(new FrozenV1FileStateStore().load(v1List(list))).rejects.toThrow(/\(line 1\)/);
      await expect(new FileStateStore().load(list.template)).rejects.toThrow(/mixes a v2 journal with a v1 snapshot/);
    });
  });
}
