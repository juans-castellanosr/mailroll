import { access } from 'node:fs/promises';
import { isEnoent } from '../fs/is-enoent';
import { backupPathFor, journalPathFor } from './history-format';
import { readHistoryFiles } from './history-upgrade';

export type HistoryPresence = 'none' | 'v1' | 'v2';

export interface HistoryInspection {
  readonly presence: HistoryPresence;
  readonly v1Snapshot: boolean;
}

export type HistoryUpgrade =
  { readonly upgraded: false } | { readonly upgraded: true; readonly backups: readonly string[] };

export async function inspectHistory(statePath: string): Promise<HistoryInspection> {
  const { snapshot, journal } = await readHistoryFiles(statePath);
  const v1Snapshot = snapshot.kind === 'v1';
  const v1JournalWithData = journal.kind === 'v1' && journal.bytes.length > 0;
  const presence: HistoryPresence = snapshot.kind === 'v2' ? 'v2' : v1Snapshot || v1JournalWithData ? 'v1' : 'none';

  return { presence, v1Snapshot };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }

    throw error;
  }
}

export async function confirmUpgrade(statePath: string, before: HistoryInspection): Promise<HistoryUpgrade> {
  if (before.presence !== 'v1') {
    return { upgraded: false };
  }

  const snapshotBackup = backupPathFor(statePath);
  const journalBackup = backupPathFor(journalPathFor(statePath));
  const [after, hasSnapshotBackup, hasJournalBackup] = await Promise.all([
    inspectHistory(statePath),
    exists(snapshotBackup),
    exists(journalBackup),
  ]);

  if (after.presence !== 'v2' || (before.v1Snapshot && !hasSnapshotBackup)) {
    return { upgraded: false };
  }

  return {
    upgraded: true,
    backups: [...(hasSnapshotBackup ? [snapshotBackup] : []), ...(hasJournalBackup ? [journalBackup] : [])],
  };
}
