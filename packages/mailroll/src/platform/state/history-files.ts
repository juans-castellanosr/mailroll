import { ConfigError, emptyState } from '@mailroll/core';
import { appendDurably, createFile, type Fence, readOptionalFile, replaceFile, truncateDurably } from './durable-files';
import {
  JOURNAL_HEADER_LINE,
  type JournalFile,
  journalPathFor,
  parseJournal,
  parseSnapshot,
  serializeSnapshot,
  type SnapshotFile,
} from './history-format';

export interface HistoryFiles {
  readonly snapshot: SnapshotFile;
  readonly journal: JournalFile;
}

export async function readHistoryFiles(statePath: string): Promise<HistoryFiles> {
  const journalPath = journalPathFor(statePath);
  const snapshotBytes = await readOptionalFile(statePath);
  const journalBytes = await readOptionalFile(journalPath);
  const snapshot: SnapshotFile =
    snapshotBytes === undefined ? { kind: 'absent' } : parseSnapshot(statePath, snapshotBytes);
  const journal: JournalFile =
    journalBytes === undefined ? { kind: 'absent' } : parseJournal(journalPath, journalBytes);

  if (snapshot.kind === 'absent' && journal.kind !== 'absent') {
    throw new ConfigError(
      `the send history at ${statePath} has a journal but no snapshot; nothing was changed, restore the matching files before running again`,
    );
  }

  return { snapshot, journal };
}

export interface WritePreparation {
  readonly statePath: string;
  readonly templateId: string;
  readonly purpose: 'append' | 'compact';
  readonly fence: Fence;
}

export async function prepareHistoryForWrite(preparation: WritePreparation): Promise<void> {
  const { statePath, templateId, purpose, fence } = preparation;
  const { snapshot, journal } = await readHistoryFiles(statePath);

  if (purpose === 'compact') {
    return;
  }

  if (snapshot.kind === 'absent') {
    await replaceFile(statePath, serializeSnapshot(emptyState(templateId)), fence);
  }

  await prepareJournal(journalPathFor(statePath), journal, fence);
}

async function prepareJournal(path: string, journal: JournalFile, fence: Fence): Promise<void> {
  if (journal.kind !== 'v2') {
    if ((await createFile(path, `${JOURNAL_HEADER_LINE}\n`)) === 'exists') {
      throw new ConfigError(
        `the state journal at ${path} appeared before this run wrote to it, so something else created it: another program while this run held the list's lock, or another run that took the lock after this run lost it; nothing was written`,
      );
    }

    return;
  }

  if (journal.tornTailStart !== undefined) {
    await truncateDurably(path, journal.tornTailStart, fence);
  } else if (journal.bytes.at(-1) !== 0x0a) {
    await fence();
    await appendDurably(path, '\n');
  }
}
