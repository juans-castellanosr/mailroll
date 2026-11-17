import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ConfigError,
  emptyState,
  foldJournal,
  type RecipientJournalEntry,
  type ResolvedTemplate,
  type StateStore,
  type StoredTemplateState,
  type TemplateState,
  upgradeTemplateState,
} from '@mailroll/core';
import { isEnoent } from '../fs/is-enoent';
import { appendDurably, type Fence, removeFile, replaceFile, syncDirectory } from './durable-files';
import { type AcquiredLock, acquireFileLock, isLockStillHeld } from './file-lock';
import { journalPathFor, serializeEntry, serializeSnapshot } from './history-format';
import { prepareHistoryForWrite, readHistoryFiles } from './history-upgrade';

interface WriteSession {
  readonly lock: AcquiredLock;
  loaded: boolean;
  lost: boolean;
  journalReady: boolean;
}

type WriteRefusal = 'not-held' | 'not-loaded' | 'lost' | 'unverifiable';

interface Refusal {
  readonly reason: WriteRefusal;
  readonly cause?: unknown;
}

const REFUSAL_REASONS: Readonly<Record<WriteRefusal, string>> = {
  'not-held': 'this store does not hold its lock',
  'not-loaded': 'it was not loaded after the lock was taken',
  lost: 'its lock file no longer belongs to this run',
  unverifiable: 'its lock file could not be read to confirm this run still owns it',
};

function refused(template: ResolvedTemplate, refusal: Refusal): ConfigError {
  return new ConfigError(
    `the send state of "${template.id}" · ${template.dataFile} can only be written by the store that holds its lock and loaded it after taking it (${REFUSAL_REASONS[refusal.reason]}); nothing was written`,
    refusal.cause === undefined ? undefined : { cause: refusal.cause },
  );
}

function lostAfterIntent(template: ResolvedTemplate, email: string, refusal: Refusal): ConfigError {
  return new ConfigError(
    `the intent to send to ${email} was written to the send state of "${template.id}" · ${template.dataFile}, but right after it this run could no longer confirm that it holds its lock (${REFUSAL_REASONS[refusal.reason]}); nothing was sent to ${email}, and the history now reads it as uncertain`,
    refusal.cause === undefined ? undefined : { cause: refusal.cause },
  );
}

function lostWhilePreparing(template: ResolvedTemplate, refusal: Refusal): ConfigError {
  return new ConfigError(
    `the send state of "${template.id}" · ${template.dataFile} can only be written by the store that holds its lock, and while preparing the history files this run could no longer confirm that it holds it (${REFUSAL_REASONS[refusal.reason]}); it stopped before changing them further`,
    refusal.cause === undefined ? undefined : { cause: refusal.cause },
  );
}

function lostAfterSnapshot(template: ResolvedTemplate, refusal: Refusal): ConfigError {
  return new ConfigError(
    `the snapshot of the send state of "${template.id}" · ${template.dataFile} was written, but right after it this run could no longer confirm that it holds its lock (${REFUSAL_REASONS[refusal.reason]}); the journal was kept, so no record written by another run was removed`,
    refusal.cause === undefined ? undefined : { cause: refusal.cause },
  );
}

export class FileStateStore implements StateStore {
  private readonly ensuredDirs = new Set<string>();
  private readonly sessions = new Map<string, WriteSession>();
  private readonly queues = new Map<string, Promise<void>>();

  async load(template: ResolvedTemplate): Promise<StoredTemplateState> {
    const session = this.sessions.get(template.statePath);
    const { snapshot, journal } = await readHistoryFiles(template.statePath);
    const base = snapshot.kind === 'absent' ? emptyState(template.id) : upgradeTemplateState(snapshot.state);
    const replayed = foldJournal(base, journal.kind === 'absent' ? [] : journal.entries);

    if (session !== undefined && this.sessions.get(template.statePath) === session) {
      session.loaded = true;
    }

    return snapshot.kind === 'v1' ? { ...replayed, version: 1 } : replayed;
  }

  append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    return this.serialized(template, () => this.appendAuthorized(template, entry));
  }

  compact(template: ResolvedTemplate, state: TemplateState): Promise<void> {
    return this.serialized(template, () => this.compactAuthorized(template, state));
  }

  async lock(template: ResolvedTemplate): Promise<AcquiredLock> {
    await this.ensureDir(dirname(template.statePath));

    const acquired = await acquireFileLock(
      `${template.statePath}.lock`,
      `the send state of "${template.id}" · ${template.dataFile}`,
    );
    const statePath = template.statePath;
    const session: WriteSession = { lock: acquired, loaded: false, lost: false, journalReady: false };

    this.sessions.set(statePath, session);

    return {
      ...acquired,
      release: async (): Promise<void> => {
        if (this.sessions.get(statePath) === session) {
          this.sessions.delete(statePath);
        }

        await this.queues.get(statePath);
        await acquired.release();
      },
    };
  }

  private serialized(template: ResolvedTemplate, operation: () => Promise<void>): Promise<void> {
    const statePath = template.statePath;
    const current = (this.queues.get(statePath) ?? Promise.resolve()).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );

    this.queues.set(statePath, tail);
    void tail.then(() => {
      if (this.queues.get(statePath) === tail) {
        this.queues.delete(statePath);
      }
    });

    return current;
  }

  private async authorize(template: ResolvedTemplate): Promise<WriteSession> {
    const session = this.sessions.get(template.statePath);

    if (session === undefined) {
      throw refused(template, { reason: 'not-held' });
    }

    const refusal = await this.refusalFor(session);

    if (refusal !== undefined) {
      throw refused(template, refusal);
    }

    if (this.sessions.get(template.statePath) !== session) {
      throw refused(template, { reason: 'not-held' });
    }

    return session;
  }

  private fenceFor(session: WriteSession, failure: (refusal: Refusal) => ConfigError): Fence {
    return async () => {
      const refusal = await this.refusalFor(session);

      if (refusal !== undefined) {
        throw failure(refusal);
      }
    };
  }

  private async refusalFor(session: WriteSession): Promise<Refusal | undefined> {
    if (session.lost) {
      return { reason: 'lost' };
    }

    if (!session.loaded) {
      return { reason: 'not-loaded' };
    }

    let held: boolean;

    try {
      held = await isLockStillHeld(session.lock);
    } catch (error) {
      session.lost = true;

      return { reason: 'unverifiable', cause: error };
    }

    if (!held) {
      session.lost = true;

      return { reason: 'lost' };
    }

    return undefined;
  }

  private async appendAuthorized(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    const session = await this.authorize(template);
    const journalPath = journalPathFor(template.statePath);
    const line = serializeEntry(entry);

    await this.ensureDir(dirname(template.statePath));

    if (!session.journalReady) {
      await this.prepare(template, session, 'append');
      session.journalReady = true;
    }

    try {
      await appendDurably(journalPath, line);
    } catch (error) {
      if (isEnoent(error)) {
        session.journalReady = false;
        throw new ConfigError(
          `the state journal at ${journalPath} disappeared during the run; nothing was written, and the run stops so no send goes unrecorded`,
          { cause: error },
        );
      }

      throw error;
    }

    if ('intent' in entry) {
      await this.fenceFor(session, (refusal) => lostAfterIntent(template, entry.email, refusal))();
    }
  }

  private async compactAuthorized(template: ResolvedTemplate, state: TemplateState): Promise<void> {
    const session = await this.authorize(template);
    const journalPath = journalPathFor(template.statePath);
    const content = serializeSnapshot(state);

    await this.ensureDir(dirname(template.statePath));

    if (!session.journalReady) {
      await this.prepare(template, session, 'compact');
    }

    await replaceFile(
      template.statePath,
      content,
      this.fenceFor(session, (refusal) => refused(template, refusal)),
    );
    session.journalReady = false;
    await removeFile(
      journalPath,
      this.fenceFor(session, (refusal) => lostAfterSnapshot(template, refusal)),
    );
  }

  private prepare(template: ResolvedTemplate, session: WriteSession, purpose: 'append' | 'compact'): Promise<void> {
    return prepareHistoryForWrite({
      statePath: template.statePath,
      templateId: template.id,
      purpose,
      locked: true,
      fence: this.fenceFor(session, (refusal) => lostWhilePreparing(template, refusal)),
    });
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) {
      return;
    }

    const created = await mkdir(dir, { recursive: true });

    for (let level = dir; created !== undefined; level = dirname(level)) {
      await syncDirectory(dirname(level));

      if (level === created || dirname(level) === level) {
        break;
      }
    }

    this.ensuredDirs.add(dir);
  }
}
