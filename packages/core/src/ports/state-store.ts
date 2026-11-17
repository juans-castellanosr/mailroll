import type { ResolvedTemplate } from '../domain/catalog/template';
import type { RecipientJournalEntry, StoredTemplateState, TemplateState } from '../domain/run/template-state';

export interface StateLock {
  release(): Promise<void>;
}

export interface StateStore {
  load(template: ResolvedTemplate): Promise<StoredTemplateState>;
  append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void>;
  compact(template: ResolvedTemplate, state: TemplateState): Promise<void>;
  lock(template: ResolvedTemplate): Promise<StateLock>;
}
