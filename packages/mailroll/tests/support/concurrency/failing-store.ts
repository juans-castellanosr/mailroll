import type {
  RecipientJournalEntry,
  ResolvedTemplate,
  StateLock,
  StateStore,
  StoredTemplateState,
  TemplateState,
} from '@mailroll/core';

export type EntryKind = 'intent' | 'status' | 'released';

export interface WriteFailure {
  readonly kind: EntryKind | 'compact';
  readonly email?: string;
  readonly written: boolean;
  readonly error?: Error;
  readonly beforeFailing?: () => Promise<void> | void;
}

export function kindOf(entry: RecipientJournalEntry): EntryKind {
  if ('intent' in entry) {
    return 'intent';
  }

  return 'status' in entry ? 'status' : 'released';
}

export class FailingStore implements StateStore {
  readonly attempted: (RecipientJournalEntry | 'compact')[] = [];
  private pending: WriteFailure | undefined;

  constructor(
    private readonly inner: StateStore,
    failure: WriteFailure,
  ) {
    this.pending = failure;
  }

  load(template: ResolvedTemplate): Promise<StoredTemplateState> {
    return this.inner.load(template);
  }

  lock(template: ResolvedTemplate): Promise<StateLock> {
    return this.inner.lock(template);
  }

  async append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    this.attempted.push(entry);

    const failure = this.take(kindOf(entry), entry.email);

    if (failure === undefined) {
      await this.inner.append(template, entry);

      return;
    }

    await this.fail(failure, () => this.inner.append(template, entry));
  }

  async compact(template: ResolvedTemplate, state: TemplateState): Promise<void> {
    this.attempted.push('compact');

    const failure = this.take('compact', undefined);

    if (failure === undefined) {
      await this.inner.compact(template, state);

      return;
    }

    await this.fail(failure, () => this.inner.compact(template, state));
  }

  private take(kind: WriteFailure['kind'], email: string | undefined): WriteFailure | undefined {
    const failure = this.pending;

    if (failure?.kind !== kind || (failure.email !== undefined && failure.email !== email)) {
      return undefined;
    }

    this.pending = undefined;

    return failure;
  }

  private async fail(failure: WriteFailure, write: () => Promise<void>): Promise<void> {
    if (failure.written) {
      await write();
    }

    await failure.beforeFailing?.();

    throw failure.error ?? new Error('injected write failure (ENOSPC: no space left on device)');
  }
}
