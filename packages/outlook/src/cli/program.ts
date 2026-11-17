import { parseArgs } from 'node:util';
import { SignInRequiredError } from '@mailroll/core';
import { OUTLOOK_VERSION } from '../version';
import type { CliOutput } from './cli-output';
import { CliError, exportSentCommand, type ExportSentContext } from './export-sent';
import { isMailrollHost, type MailrollHost, MissingHostError } from './host';

export const EXIT = { ok: 0, attention: 1, usage: 2 } as const;

export interface OutlookCliIo {
  readonly out: CliOutput;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
  readonly writeOut: (text: string) => void;
  readonly loadHost: () => Promise<unknown>;
  readonly fetchFn?: ExportSentContext['fetchFn'];
  readonly authFor?: ExportSentContext['authFor'];
}

const HELP = `Usage: mailroll-outlook [options] export-sent [options]

Microsoft Outlook tools for mailroll.

Commands:
  export-sent                   export a connection's Outlook Sent Items (read-only) to a new JSON file

Options:
  -C, --campaigns <dir>         folder that holds the campaigns (default: "campaigns")
  --no-color                    disable colored output (NO_COLOR is honored too)
  -q, --quiet                   accepted for compatibility with mailroll; export-sent prints only its result
  -V, --version                 output the version number
  -h, --help                    display help

export-sent options:
  -c, --campaign <group/name>   campaign id
  --connection <id>             connection id
  --since <YYYY-MM-DD>          first day to export (UTC)
  -o, --out <file>              output file; it must not exist yet

Exit codes: 0 ok · 1 something failed · 2 invalid usage, or a sign-in is needed without a terminal
`;

const OPTIONS = {
  campaigns: { type: 'string', short: 'C', default: 'campaigns' },
  'no-color': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  version: { type: 'boolean', short: 'V' },
  help: { type: 'boolean', short: 'h' },
  campaign: { type: 'string', short: 'c' },
  connection: { type: 'string' },
  since: { type: 'string' },
  out: { type: 'string', short: 'o' },
} as const;

const REQUIRED = [
  ['campaign', '-c, --campaign <group/name>'],
  ['connection', '--connection <id>'],
  ['since', '--since <YYYY-MM-DD>'],
  ['out', '-o, --out <file>'],
] as const;

class ArgumentError extends CliError {}

async function loadHost(io: OutlookCliIo): Promise<MailrollHost> {
  let host: unknown;

  try {
    host = await io.loadHost();
  } catch (error) {
    if (error instanceof MissingHostError) {
      throw new CliError(
        'mailroll-outlook export-sent reads your campaigns through mailroll, which is not installed in this project; ' +
          'install it next to @mailroll/outlook (for example "npm install mailroll")',
        { cause: error },
      );
    }

    throw error;
  }

  if (!isMailrollHost(host)) {
    throw new CliError(
      'this mailroll is too old for mailroll-outlook (it lacks connectionStateLocation); ' +
        'install a mailroll version that matches @mailroll/outlook',
    );
  }

  return host;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];

  for (let current: unknown = error; current !== undefined && chain.length < 5;) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain;
}

function describeError(error: unknown): string {
  const parts: string[] = [];

  for (const link of errorChain(error)) {
    const text = link instanceof Error ? link.message : typeof link === 'string' ? link : 'non-error value thrown';

    if (!parts.some((part) => part.includes(text))) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join('\n  caused by: ') : 'unknown error';
}

async function run(argv: readonly string[], io: OutlookCliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  if (values.help === true) {
    io.writeOut(HELP);

    return EXIT.ok;
  }

  if (values.version === true) {
    io.writeOut(`${OUTLOOK_VERSION}\n`);

    return EXIT.ok;
  }

  const [command, ...extra] = positionals;

  if (command !== 'export-sent' || extra.length > 0) {
    throw new ArgumentError(
      command === undefined
        ? 'missing command (commands: export-sent)'
        : `unknown command "${command}" (commands: export-sent)`,
    );
  }

  const missing = REQUIRED.filter(([name]) => values[name] === undefined).map(([, flag]) => flag);

  if (missing.length > 0) {
    throw new ArgumentError(`required option '${missing.join("', '")}' not specified`);
  }

  await exportSentCommand(
    {
      campaignsRoot: values.campaigns,
      env: io.env,
      out: io.out,
      interactive: io.interactive,
      host: await loadHost(io),
      ...(io.fetchFn === undefined ? {} : { fetchFn: io.fetchFn }),
      ...(io.authFor === undefined ? {} : { authFor: io.authFor }),
    },
    {
      campaign: values.campaign ?? '',
      connection: values.connection ?? '',
      since: values.since ?? '',
      out: values.out ?? '',
    },
  );

  return EXIT.ok;
}

function isUsageError(error: unknown): boolean {
  return (
    error instanceof CliError ||
    (error instanceof TypeError && String(Reflect.get(error, 'code')).startsWith('ERR_PARSE_ARGS_')) ||
    errorChain(error).some((link) => link instanceof SignInRequiredError)
  );
}

export async function runOutlookCli(argv: readonly string[], io: OutlookCliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (isUsageError(error)) {
      const usage = errorChain(error).find((link) => link instanceof SignInRequiredError) ?? error;

      io.out.error(usage instanceof Error ? usage.message : describeError(usage));

      if (error instanceof TypeError || error instanceof ArgumentError) {
        io.out.info('(run with --help for usage)');
      }

      return EXIT.usage;
    }

    io.out.error(describeError(error));

    return EXIT.attention;
  }
}
