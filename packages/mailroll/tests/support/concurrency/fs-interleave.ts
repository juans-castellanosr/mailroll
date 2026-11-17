import { AsyncLocalStorage } from 'node:async_hooks';
import { basename } from 'node:path';
import { Checkpoints } from './barrier';

export type FsOperation = 'open' | 'rename' | 'link' | 'rm';

interface Watch {
  readonly name: string;
  readonly actor: string;
  readonly operation: FsOperation;
  readonly occurrence: number;
  readonly matches: (file: string) => boolean;
  seen: number;
}

const anyFile = (): boolean => true;

export class FsInterleaver {
  readonly trace: string[] = [];
  private readonly actor = new AsyncLocalStorage<string>();
  private checkpoints = new Checkpoints();
  private watches: Watch[] = [];

  as<T>(actor: string, work: () => Promise<T>): Promise<T> {
    return this.actor.run(actor, work);
  }

  pauseBefore(
    actor: string,
    operation: FsOperation,
    occurrence = 1,
    matches: (file: string) => boolean = anyFile,
  ): string {
    const name = `${actor}:${operation}:${String(occurrence)}:${String(this.watches.length)}`;

    this.watches.push({ name, actor, operation, occurrence, matches, seen: 0 });
    this.checkpoints.watch(name);

    return name;
  }

  reached(checkpoint: string): Promise<void> {
    return this.checkpoints.reached(checkpoint);
  }

  release(checkpoint: string): void {
    this.checkpoints.release(checkpoint);
  }

  reset(): void {
    this.trace.length = 0;
    this.watches = [];
    this.checkpoints = new Checkpoints();
  }

  async before(operation: FsOperation, paths: readonly unknown[]): Promise<void> {
    const actor = this.actor.getStore();

    if (actor === undefined) {
      return;
    }

    const names = paths.map((path) => (typeof path === 'string' ? basename(path) : '?'));
    const first = names[0] ?? '?';

    for (const watch of this.watches) {
      if (watch.actor !== actor || watch.operation !== operation || !watch.matches(first)) {
        continue;
      }

      watch.seen += 1;

      if (watch.seen === watch.occurrence) {
        await this.checkpoints.arrive(watch.name);
      }
    }

    this.trace.push(`${actor} ${operation} ${names.join(' → ')}`);
  }

  wrap<A extends readonly unknown[], R>(
    operation: FsOperation,
    pathCount: number,
    original: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      await this.before(operation, args.slice(0, pathCount));

      return original(...args);
    };
  }
}

export const interleaver = new FsInterleaver();
