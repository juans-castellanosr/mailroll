export interface Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
