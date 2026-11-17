import { Command, CommanderError, Option } from 'commander';
import { SignInRequiredError } from '@mailroll/core';
import { CliError } from './cli-error';
import { describeError, findInChain, isPromptExit } from './error-chain';
import { buildTemplateCommand } from './commands/build-template';
import { menuCommand } from './commands/menu';
import { sendCommand, type SendCommandOptions } from './commands/send';
import { statusCommand } from './commands/status';
import { type CliContext, EXIT } from './context';
import type { Output } from './output';
import { VERSION } from './version';
import type { LogLevel } from '../logging/console-logger';

export interface CliIo {
  readonly out: Output;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly loadIntegrations: (cwd: string) => Promise<readonly unknown[]>;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

interface GlobalOptions {
  readonly campaigns: string;
  readonly color: boolean;
  readonly quiet?: boolean;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let exitCode: number = EXIT.ok;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });

  try {
    await program.parseAsync([...argv], { from: 'user' });

    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }

    if (isPromptExit(error)) {
      io.out.info('Canceled — nothing was sent.');

      return EXIT.interrupted;
    }

    const usage = error instanceof CliError ? error : findInChain(error, SignInRequiredError);

    if (usage !== undefined) {
      io.out.error(usage.message);

      return EXIT.usage;
    }

    io.out.error(describeError(error));

    return EXIT.attention;
  }
}

function buildProgram(io: CliIo, setExit: (code: number) => void): Command {
  const program = new Command('mailroll')
    .description('Send personalized email campaigns from CSV lists, with per-list history and safe resends.')
    .version(VERSION, '-V, --version')
    .option(
      '-C, --campaigns <dir>',
      'folder that holds the campaigns (<group>/<name>/campaign.config.json)',
      'campaigns',
    )
    .option('--no-color', 'disable colored output (NO_COLOR is honored too)')
    .option('-q, --quiet', 'hide per-send progress logs (warnings and errors are still shown)')
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
    .configureOutput({ writeOut: io.writeOut, writeErr: io.writeErr })
    .addHelpText(
      'after',
      '\nExit codes: 0 ok · 1 something needs attention or failed · 2 invalid usage · 130 stopped with Ctrl-C' +
        '\nRun "mailroll" alone in a terminal for the guided menu.',
    )
    .hook('preAction', (thisCommand) => {
      if (!thisCommand.optsWithGlobals<GlobalOptions>().color) {
        io.env['NO_COLOR'] = '1';
        io.env['FORCE_COLOR'] = '0';
      }
    });

  const context = (command: Command): CliContext => {
    const globals = command.optsWithGlobals<GlobalOptions>();

    return {
      campaignsRoot: globals.campaigns,
      env: io.env,
      out: io.out,
      logLevel: logLevelOf(globals),
      interactive: io.interactive,
      cwd: io.cwd,
      loadIntegrations: io.loadIntegrations,
    };
  };

  const run =
    <A extends unknown[]>(action: (command: Command, ...args: A) => Promise<number>) =>
    async (...args: [...A, unknown, Command]): Promise<void> => {
      const command = args[args.length - 1] as Command;

      setExit(await action(command, ...(args.slice(0, -2) as A)));
    };

  program.allowExcessArguments().action(
    run(async (command) => {
      const [unknown] = command.args;

      if (unknown !== undefined) {
        const known = program.commands.map((c) => c.name()).join(', ');

        throw new CliError(`unknown command "${unknown}" (commands: ${known})`);
      }

      if (!io.interactive) {
        io.writeErr(program.helpInformation());

        return EXIT.usage;
      }

      return menuCommand(context(command));
    }),
  );

  program
    .command('send')
    .description('run a campaign non-interactively (dry-run previews, test inbox or live send)')
    .requiredOption('-c, --campaign <group/name>', 'campaign id')
    .requiredOption('-t, --template <ids>', 'template id(s), comma separated')
    .requiredOption('--connection <ids>', 'connection id(s), comma separated; several share the load')
    .addOption(
      new Option('-m, --mode <mode>', 'what to do with each message')
        .choices(['dry-run', 'test', 'live'])
        .makeOptionMandatory(),
    )
    .option('-d, --data <files>', 'CSV file(s) in the template data/ folder, comma separated')
    .option('--cc <emails>', 'CC address(es), comma separated; "" sends without CC')
    .addOption(
      new Option('-p, --policy <policy>', 'which recipients to send to').choices([
        'pending',
        'failed-only',
        'force-all',
        'subset',
      ]),
    )
    .option('--recipients <emails>', 'recipients for --policy subset, comma separated')
    .option('--to <email>', 'test inbox for --mode test (default: TEST_RECIPIENT)')
    .option('--confirm', 'required with --mode live: confirms a real send')
    .option('--write-previews', 'with --mode dry-run: write the rendered HTML to the previews folder')
    .option('--previews-dir <dir>', 'folder for --write-previews (default: "previews")')
    .option('--json', 'print the run summary as JSON on stdout')
    .action(
      run(async (command) => {
        return sendCommand(context(command), command.opts<SendCommandOptions>());
      }),
    );

  program
    .command('status')
    .description('show, per template and CSV list, how many recipients are new, sent, failed or uncertain')
    .option('--json', 'print the status as JSON on stdout')
    .action(run(async (command) => statusCommand(context(command), command.opts<{ json?: boolean }>())));

  program
    .command('build-template')
    .description('compile a template view (view/template.mjml → view/compiled.html); needs the optional mjml package')
    .argument('<template-dir>', 'the template folder (the one that contains view/)')
    .action(run(async (command, templateDir: string) => buildTemplateCommand(context(command), templateDir)));

  return program;
}

function logLevelOf(globals: GlobalOptions): LogLevel {
  return globals.quiet === true ? 'warn' : 'info';
}
