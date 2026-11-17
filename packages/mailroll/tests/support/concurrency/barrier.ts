export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

interface Checkpoint {
  readonly reached: Deferred<void>;
  readonly released: Deferred<void>;
}

export class Checkpoints {
  private readonly points = new Map<string, Checkpoint>();

  private point(name: string): Checkpoint {
    const existing = this.points.get(name);

    if (existing !== undefined) {
      return existing;
    }

    const created: Checkpoint = { reached: deferred(), released: deferred() };

    this.points.set(name, created);

    return created;
  }

  isWatched(name: string): boolean {
    return this.points.has(name);
  }

  watch(name: string): void {
    this.point(name);
  }

  arrive(name: string): Promise<void> {
    const point = this.point(name);

    point.reached.resolve();

    return point.released.promise;
  }

  reached(name: string): Promise<void> {
    return this.point(name).reached.promise;
  }

  release(name: string): void {
    this.point(name).released.resolve();
  }
}
