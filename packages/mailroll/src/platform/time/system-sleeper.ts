import { setTimeout as delay } from 'node:timers/promises';
import type { Sleeper } from '@mailroll/core';

export class SystemSleeper implements Sleeper {
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return;
    }

    try {
      await delay(ms, undefined, signal !== undefined ? { signal } : {});
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
    }
  }
}
