import type { ResolvedTemplate } from '../domain/catalog/template';
import { ConfigError } from '../domain/kernel/errors';
import { foldJournal } from '../domain/run/fold-journal';
import { type RecipientJournalEntry, type TemplateState, emptyState } from '../domain/run/template-state';
import type { StateLock, StateStore } from '../ports/state-store';

export class MemoryStateStore implements StateStore {
  private readonly snapshots = new Map<string, TemplateState>();
  private readonly journals = new Map<string, RecipientJournalEntry[]>();
  private readonly held = new Set<string>();

  load(template: ResolvedTemplate): Promise<TemplateState> {
    return Promise.resolve(
      foldJournal(
        this.snapshots.get(template.statePath) ?? emptyState(template.id),
        this.journals.get(template.statePath) ?? [],
      ),
    );
  }

  append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    const journal = this.journals.get(template.statePath) ?? [];

    journal.push(entry);
    this.journals.set(template.statePath, journal);

    return Promise.resolve();
  }

  compact(template: ResolvedTemplate, state: TemplateState): Promise<void> {
    this.snapshots.set(template.statePath, state);
    this.journals.delete(template.statePath);

    return Promise.resolve();
  }

  lock(template: ResolvedTemplate): Promise<StateLock> {
    const key = template.statePath;

    if (this.held.has(key)) {
      return Promise.reject(new ConfigError(`the send state of "${template.id}" is in use by another run`));
    }

    this.held.add(key);

    return Promise.resolve({
      release: () => {
        this.held.delete(key);

        return Promise.resolve();
      },
    });
  }
}
