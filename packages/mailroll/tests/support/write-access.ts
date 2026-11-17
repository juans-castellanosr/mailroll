import type { ResolvedTemplate, StateLock, StateStore } from '@mailroll/core';

export async function withLock<T>(store: StateStore, template: ResolvedTemplate, work: () => Promise<T>): Promise<T> {
  const lock = await store.lock(template);

  try {
    return await work();
  } finally {
    await lock.release();
  }
}

export async function openForWriting(store: StateStore, template: ResolvedTemplate): Promise<StateLock> {
  const lock = await store.lock(template);

  try {
    await store.load(template);
  } catch (error) {
    await lock.release();
    throw error;
  }

  return lock;
}

export async function asWriter<T>(store: StateStore, template: ResolvedTemplate, work: () => Promise<T>): Promise<T> {
  const lock = await openForWriting(store, template);

  try {
    return await work();
  } finally {
    await lock.release();
  }
}
