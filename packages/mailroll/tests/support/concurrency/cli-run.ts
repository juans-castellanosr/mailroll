import { Writable } from 'node:stream';
import { createOutput } from '../../../src/platform/cli/output';
import { runCli } from '../../../src/platform/cli/program';
import { connectionEnvKey } from '../../../src/platform/config/resolve-connection-secrets';
import { ledgerIntegration, type SendLedger } from './send-ledger';

export const CLI_CAMPAIGN = 'acme/onboarding';
export const CLI_STATE = 'acme/onboarding/templates/welcome/.state/recipients.json';
export const CLI_EMAILS: readonly string[] = ['ada@example.com', 'grace@example.com', 'alan@example.org'];

export interface LiveCliRun {
  readonly campaigns: string;
  readonly cwd: string;
  readonly ledger: SendLedger;
  readonly run: string;
  readonly gate?: (to: string) => Promise<void>;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function collector(append: (text: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      append(String(chunk));
      done();
    },
  });
}

export async function runLiveCli(options: LiveCliRun): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(
    [
      '-C',
      options.campaigns,
      '-q',
      'send',
      '-c',
      CLI_CAMPAIGN,
      '-t',
      'welcome',
      '--connection',
      'outlook-1',
      '-m',
      'live',
      '--confirm',
      '--cc',
      '',
      '--json',
    ],
    {
      out: createOutput({
        stdout: collector((text) => {
          stdout += text;
        }),
        stderr: collector((text) => {
          stderr += text;
        }),
      }),
      env: { [connectionEnvKey(CLI_CAMPAIGN, 'outlook-1', 'TOKEN')]: 'not-a-secret' },
      interactive: false,
      cwd: options.cwd,
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
      loadIntegrations: () =>
        Promise.resolve([
          ledgerIntegration({
            ledger: options.ledger,
            run: options.run,
            policy: 'pending',
            ...(options.gate === undefined ? {} : { gate: options.gate }),
          }),
        ]),
    },
  );

  return { exitCode, stdout, stderr };
}
