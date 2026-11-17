import { type ChildProcess, fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deferred, type Deferred } from './barrier';
import { type ChildDone, type ChildJob, parseChildMessage, type ParentMessage } from './child-protocol';

const PACKAGE = resolve(import.meta.dirname, '../../..');
const CHILD = join(import.meta.dirname, 'child-run.ts');
const TSX = pathToFileURL(createRequire(join(PACKAGE, 'package.json')).resolve('tsx')).href;
const LIMIT_MS = 30_000;

const running = new Set<ChildRun>();

export class ChildRun {
  readonly done: Promise<ChildDone>;
  readonly pid: Promise<number>;
  private readonly arrivals: string[] = [];
  private readonly arrivalWaiters: Deferred<string>[] = [];
  private readonly lockedPid = deferred<number>();
  private readonly finished = deferred<ChildDone>();
  private readonly process: ChildProcess;
  private readonly timer: NodeJS.Timeout;
  private stderr = '';

  private constructor(job: ChildJob) {
    this.process = fork(CHILD, [JSON.stringify(job)], {
      execArgv: ['--import', TSX],
      env: { ...process.env, TSX_TSCONFIG_PATH: join(PACKAGE, 'tsconfig.json'), NODE_OPTIONS: '' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.done = this.finished.promise;
    this.pid = this.lockedPid.promise;
    this.timer = setTimeout(() => {
      this.finished.resolve({ type: 'done', ok: false, detail: `child timed out after ${String(LIMIT_MS)} ms` });
      this.kill();
    }, LIMIT_MS);
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.process.on('message', (raw: unknown) => {
      const message = parseChildMessage(raw);

      if (message?.type === 'at-send') {
        const waiter = this.arrivalWaiters.shift();

        if (waiter === undefined) {
          this.arrivals.push(message.to);
        } else {
          waiter.resolve(message.to);
        }
      } else if (message?.type === 'locked') {
        this.lockedPid.resolve(message.pid);
      } else if (message?.type === 'done') {
        this.finished.resolve(message);
      }
    });
    this.process.on('exit', (code, signal) => {
      clearTimeout(this.timer);
      running.delete(this);
      this.finished.resolve({
        type: 'done',
        ok: false,
        detail: `child exited (code ${String(code)}, signal ${String(signal)}) before reporting: ${this.stderr.slice(-1_000)}`,
      });
    });
    running.add(this);
  }

  static start(job: ChildJob): ChildRun {
    return new ChildRun(job);
  }

  nextSend(): Promise<string> {
    const arrived = this.arrivals.shift();

    if (arrived !== undefined) {
      return Promise.resolve(arrived);
    }

    const waiter = deferred<string>();

    this.arrivalWaiters.push(waiter);

    return waiter.promise;
  }

  go(to: string): void {
    const message: ParentMessage = { type: 'go', to };

    this.process.send(message);
  }

  exited(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise((resolve) =>
      this.process.once('exit', () => {
        resolve();
      }),
    );
  }

  kill(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGKILL');
    }
  }
}

export async function stopAllChildren(): Promise<void> {
  const children = [...running];

  for (const child of children) {
    child.kill();
  }

  await Promise.all(children.map((child) => child.exited()));
}

export type ChildStep =
  { readonly kind: 'send'; readonly to: string } | { readonly kind: 'done'; readonly done: ChildDone };

export function nextSendOrDone(child: ChildRun): Promise<ChildStep> {
  return Promise.race([
    child.nextSend().then((to): ChildStep => ({ kind: 'send', to })),
    child.done.then((done): ChildStep => ({ kind: 'done', done })),
  ]);
}

export async function pumpUntilDone(child: ChildRun, first?: ChildStep): Promise<ChildDone> {
  for (let step = first ?? (await nextSendOrDone(child)); ; step = await nextSendOrDone(child)) {
    if (step.kind === 'done') {
      return step.done;
    }

    child.go(step.to);
  }
}
