import { acquireFileLock } from '../../../src/platform/state/file-lock';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { type ChildJob, type ChildMessage, parseChildJob, parseParentMessage } from './child-protocol';
import { runLiveCli } from './cli-run';
import { listAt, runList, runLocked } from './list-run';
import { preparedLedgerSender, SendLedger } from './send-ledger';

const waiting = new Map<string, () => void>();

function tell(message: ChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('child-run must be started with an IPC channel'));

      return;
    }

    process.send(message, (error: Error | null) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

process.on('message', (raw: unknown) => {
  const message = parseParentMessage(raw);

  if (message !== undefined) {
    waiting.get(message.to)?.();
    waiting.delete(message.to);
  }
});

function goFor(to: string): Promise<void> {
  return new Promise((resolve) => {
    waiting.set(to, resolve);
  });
}

async function gate(to: string): Promise<void> {
  const go = goFor(to);

  await tell({ type: 'at-send', to });
  await go;
}

async function perform(job: ChildJob): Promise<string> {
  switch (job.kind) {
    case 'lock-and-exit': {
      await acquireFileLock(job.lockPath, 'the list');
      await tell({ type: 'locked', pid: process.pid });

      return process.exit(0);
    }

    case 'lock-and-hold': {
      const lock = await acquireFileLock(job.lockPath, 'the list');
      const release = goFor('release');

      await tell({ type: 'locked', pid: process.pid });
      await release;
      await lock.release();

      return 'released';
    }

    case 'sdk': {
      const store = new FileStateStore();
      const ledger = new SendLedger(job.ledgerPath);
      const sender = await preparedLedgerSender({ ledger, run: job.run, policy: 'pending', gate });
      const options = { list: listAt(job.statePath, job.emails), store, senders: new Map([['outlook-1', sender]]) };
      const report = job.lock ? await runLocked(options) : await runList(options);

      return JSON.stringify({ sent: report.sent, uncertain: report.uncertain, notAttempted: report.notAttempted });
    }

    case 'cli': {
      const result = await runLiveCli({
        campaigns: job.campaigns,
        cwd: job.cwd,
        ledger: new SendLedger(job.ledgerPath),
        run: job.run,
        gate,
      });

      return JSON.stringify({ exitCode: result.exitCode, stderr: result.stderr.slice(-2_000) });
    }
  }
}

async function main(): Promise<void> {
  try {
    const detail = await perform(parseChildJob(process.argv[2]));

    await tell({ type: 'done', ok: true, detail });
  } catch (error) {
    await tell({ type: 'done', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  process.disconnect();
}

void main();
