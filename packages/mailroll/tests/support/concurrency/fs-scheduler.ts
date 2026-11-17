import { AsyncLocalStorage } from 'node:async_hooks';
import type { FileHandle } from 'node:fs/promises';

type ActorState = 'running' | 'waiting' | 'done';

export interface Decision {
  readonly waiting: readonly string[];
  readonly previous: string | undefined;
  readonly chosen: string;
}

export interface ScheduledActor<T> {
  readonly name: string;
  readonly work: () => Promise<T>;
}

export type Settled<T> =
  | { readonly name: string; readonly ok: true; readonly value: T }
  | { readonly name: string; readonly ok: false; readonly error: unknown };

const HANDLE_STEPS: ReadonlySet<PropertyKey> = new Set(['writeFile', 'readFile']);

export class FsScheduler {
  private readonly actor = new AsyncLocalStorage<string>();
  private readonly states = new Map<string, ActorState>();
  private readonly grants = new Map<string, () => void>();
  private onChange: (() => void) | undefined;
  private relevant: (path: string) => boolean = () => true;

  only(relevant: (path: string) => boolean): void {
    this.relevant = relevant;
  }

  wrap<A extends readonly unknown[], R>(original: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      if (this.isRelevant(args[0])) {
        await this.step();
      }

      return original(...args);
    };
  }

  wrapOpen<A extends readonly unknown[]>(
    original: (...args: A) => Promise<FileHandle>,
  ): (...args: A) => Promise<FileHandle> {
    return async (...args: A): Promise<FileHandle> => {
      const relevant = this.isRelevant(args[0]);

      if (relevant) {
        await this.step();
      }

      const handle = await original(...args);

      return this.actor.getStore() === undefined || !relevant ? handle : this.scheduledHandle(handle);
    };
  }

  async run<T>(
    actors: readonly ScheduledActor<T>[],
    choose: (waiting: readonly string[], previous: string | undefined) => string,
  ): Promise<{ readonly settled: readonly Settled<T>[]; readonly decisions: readonly Decision[] }> {
    const decisions: Decision[] = [];
    const settled: Settled<T>[] = [];
    let previous: string | undefined;

    for (const { name } of actors) {
      this.states.set(name, 'running');
    }

    const finished = actors.map(({ name, work }) =>
      this.actor
        .run(name, work)
        .then(
          (value): Settled<T> => ({ name, ok: true, value }),
          (error: unknown): Settled<T> => ({ name, ok: false, error }),
        )
        .then((outcome) => {
          settled.push(outcome);
          this.states.set(name, 'done');
          this.onChange?.();
        }),
    );

    for (;;) {
      await this.quiescent();

      const waiting = actors.map(({ name }) => name).filter((name) => this.states.get(name) === 'waiting');

      if (waiting.length === 0) {
        break;
      }

      const chosen = choose(waiting, previous);
      const grant = this.grants.get(chosen);

      if (grant === undefined || !waiting.includes(chosen)) {
        throw new Error(`scheduler: ${chosen} is not waiting (waiting: ${waiting.join(', ')})`);
      }

      decisions.push({ waiting, previous, chosen });
      previous = chosen;
      this.grants.delete(chosen);
      this.states.set(chosen, 'running');
      grant();
    }

    await Promise.all(finished);
    this.states.clear();

    return { settled, decisions };
  }

  private isRelevant(path: unknown): boolean {
    return typeof path === 'string' && this.relevant(path);
  }

  private step(): Promise<void> {
    const name = this.actor.getStore();

    if (name === undefined || !this.states.has(name)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.grants.set(name, resolve);
      this.states.set(name, 'waiting');
      this.onChange?.();
    });
  }

  private scheduledHandle(handle: FileHandle): FileHandle {
    return new Proxy(handle, {
      get: (target, property, receiver): unknown => {
        const value: unknown = Reflect.get(target, property, receiver);

        if (typeof value !== 'function') {
          return value;
        }

        const method = value as (...args: unknown[]) => unknown;

        return HANDLE_STEPS.has(property)
          ? async (...args: unknown[]): Promise<unknown> => {
              await this.step();

              return method.apply(target, args);
            }
          : (...args: unknown[]): unknown => method.apply(target, args);
      },
    });
  }

  private quiescent(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if ([...this.states.values()].every((state) => state !== 'running')) {
          this.onChange = undefined;
          resolve();
        }
      };

      this.onChange = check;
      check();
    });
  }
}

export const scheduler = new FsScheduler();

export interface Exploration<T> {
  readonly schedules: number;
  readonly failures: readonly { readonly choices: readonly string[]; readonly problem: string }[];
  readonly outcomes: readonly (readonly Settled<T>[])[];
}

function switches(decisions: readonly Decision[]): number {
  return decisions.filter(
    (decision) =>
      decision.previous !== undefined &&
      decision.chosen !== decision.previous &&
      decision.waiting.includes(decision.previous),
  ).length;
}

export async function explore<T>(options: {
  readonly maxSwitches: number;
  readonly once: (
    choose: (waiting: readonly string[], previous: string | undefined) => string,
  ) => Promise<{ readonly settled: readonly Settled<T>[]; readonly decisions: readonly Decision[] }>;
  readonly check: (settled: readonly Settled<T>[]) => Promise<string | undefined>;
}): Promise<Exploration<T>> {
  const pending: (readonly string[])[] = [[]];
  const failures: { readonly choices: readonly string[]; readonly problem: string }[] = [];
  const outcomes: (readonly Settled<T>[])[] = [];
  let schedules = 0;

  for (let prefix = pending.pop(); prefix !== undefined; prefix = pending.pop()) {
    const forced = prefix;
    let index = 0;
    const { settled, decisions } = await options.once((waiting, previous) => {
      const planned = forced[index];

      index += 1;

      if (planned !== undefined) {
        return planned;
      }

      return previous !== undefined && waiting.includes(previous) ? previous : (waiting[0] ?? '');
    });

    schedules += 1;
    outcomes.push(settled);

    const problem = await options.check(settled);
    const choices = decisions.map((decision) => decision.chosen);

    if (problem !== undefined) {
      failures.push({ choices, problem });
    }

    for (let at = forced.length; at < decisions.length; at += 1) {
      const decision = decisions[at];

      if (decision === undefined) {
        continue;
      }

      for (const alternative of decision.waiting) {
        if (alternative === decision.chosen) {
          continue;
        }

        const candidate = [...decisions.slice(0, at), { ...decision, chosen: alternative }];

        if (switches(candidate) <= options.maxSwitches) {
          pending.push(candidate.map((step) => step.chosen));
        }
      }
    }
  }

  return { schedules, failures, outcomes };
}
