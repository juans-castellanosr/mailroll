import { ConfigError, emptyState, foldJournal, upgradeTemplateState } from '@mailroll/core';
import {
  appendDurably,
  createFile,
  type Fence,
  moveFile,
  readOptionalFile,
  removeFile,
  replaceFile,
  truncateDurably,
} from './durable-files';
import {
  assertMovableV1Journal,
  assertUpgradableV1Snapshot,
  backupPathFor,
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

  if (snapshot.kind !== 'v2' && journal.kind === 'v2') {
    throw new ConfigError(
      `the send history at ${statePath} mixes a v2 journal with ${snapshot.kind === 'v1' ? 'a v1' : 'no'} snapshot; nothing was changed, restore the matching files before running again`,
    );
  }

  return { snapshot, journal };
}

export interface WritePreparation {
  readonly statePath: string;
  readonly templateId: string;
  readonly purpose: 'append' | 'compact';
  readonly locked: boolean;
  readonly fence: Fence;
}

export async function prepareHistoryForWrite(preparation: WritePreparation): Promise<void> {
  const { statePath, templateId, purpose, fence } = preparation;
  const journalPath = journalPathFor(statePath);
  const { snapshot, journal } = await readHistoryFiles(statePath);
  const hasV1 = snapshot.kind === 'v1' || journal.kind === 'v1';

  if (hasV1 && !preparation.locked) {
    throw new ConfigError(
      `the send history at ${statePath} is in the v1 format; only a live run that holds its lock may upgrade it, and nothing was changed`,
    );
  }

  if (snapshot.kind === 'v1') {
    assertUpgradableV1Snapshot(statePath, snapshot.bytes);
  }

  if (journal.kind === 'v1') {
    assertMovableV1Journal(journalPath, journal.bytes);
  }

  if (snapshot.kind === 'v1') {
    await keepBackup(statePath, snapshot.bytes);
  }

  if (snapshot.kind !== 'v2' && (hasV1 || purpose === 'append')) {
    const base = snapshot.kind === 'v1' ? upgradeTemplateState(snapshot.state) : emptyState(templateId);

    await replaceFile(
      statePath,
      serializeSnapshot(foldJournal(base, journal.kind === 'v1' ? journal.entries : [])),
      fence,
    );
  }

  if (journal.kind === 'v1') {
    await retireV1Journal(journalPath, journal.bytes, fence);
  }

  if (purpose === 'append') {
    await prepareV2Journal(journalPath, journal, fence);
  }
}

async function keepBackup(path: string, bytes: Buffer): Promise<void> {
  const backup = backupPathFor(path);

  if ((await createFile(backup, bytes)) === 'exists') {
    await assertSameBackup(backup, bytes);
  }
}

async function retireV1Journal(path: string, bytes: Buffer, fence: Fence): Promise<void> {
  if (bytes.length === 0) {
    await removeFile(path, fence);

    return;
  }

  const backup = backupPathFor(path);

  if ((await moveFile(path, backup, fence)) === 'exists') {
    await assertSameBackup(backup, bytes);
    await removeFile(path, fence);
  }
}

async function assertSameBackup(backup: string, bytes: Buffer): Promise<void> {
  const existing = await readOptionalFile(backup);

  if (existing?.equals(bytes) !== true) {
    throw new ConfigError(
      `cannot upgrade the send history: ${backup} already exists with other content, so the history changed after that backup was taken (for example by an older mailroll); compare both files, keep the one you trust somewhere safe, remove ${backup} and run again (nothing else was changed)`,
    );
  }
}

async function prepareV2Journal(path: string, journal: JournalFile, fence: Fence): Promise<void> {
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
