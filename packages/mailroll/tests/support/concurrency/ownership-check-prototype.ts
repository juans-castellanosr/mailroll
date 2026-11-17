import { existsSync, readFileSync } from 'node:fs';
import type {
  RecipientJournalEntry,
  ResolvedTemplate,
  StateLock,
  StateStore,
  StoredTemplateState,
  TemplateState,
} from '@mailroll/core';

export type CheckedWrite = RecipientJournalEntry | 'compact';

export class OwnershipCheckingStore implements StateStore {
  readonly refusals: string[] = [];
  private owner: string | undefined;

  constructor(
    private readonly inner: StateStore,
    private readonly afterCheck: (write: CheckedWrite) => Promise<void> = () => Promise.resolve(),
  ) {}

  load(template: ResolvedTemplate): Promise<StoredTemplateState> {
    return this.inner.load(template);
  }

  async lock(template: ResolvedTemplate): Promise<StateLock> {
    const lock = await this.inner.lock(template);

    this.owner = readFileSync(`${template.statePath}.lock`, 'utf8');

    return lock;
  }

  async append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    this.check(template, entry.email);
    await this.afterCheck(entry);
    await this.inner.append(template, entry);
  }

  async compact(template: ResolvedTemplate, state: TemplateState): Promise<void> {
    this.check(template, 'compact');
    await this.afterCheck('compact');
    await this.inner.compact(template, state);
  }

  private check(template: ResolvedTemplate, what: string): void {
    const path = `${template.statePath}.lock`;
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;

    if (this.owner === undefined || current !== this.owner) {
      this.refusals.push(what);

      throw new Error(`prototype: the lock of ${template.statePath} is no longer ours; nothing was written`);
    }
  }
}
