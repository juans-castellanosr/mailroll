import { type EmailAddress, needsAttention, RunCancelledError, type SendSelection } from '@mailroll/core';
import { resolveCcInteractive } from '../cc';
import { CliError } from '../cli-error';
import { type CliContext, EXIT } from '../context';
import { handleInterrupts } from '../interrupt';
import { type Interruption, printSummary, summaryJson } from '../run-summary';
import { type SendOptionValues, selectionFromValues } from '../args';
import { RunInterruptedError, runSelection, type TemplateRunResult } from '../../composition/build-runner';
import { ConsoleLogger } from '../../logging/console-logger';

export interface SendCommandOptions extends SendOptionValues {
  readonly json?: boolean | undefined;
}

export async function sendCommand(ctx: CliContext, options: SendCommandOptions): Promise<number> {
  const { selection, writePreviews, previewsDir } = selectionFromValues(options, ctx.env);

  return executeSelection(ctx, selection, {
    writePreviews,
    previewsDir,
    json: options.json === true,
    resolveCc: (params) => promptForCc(ctx, params),
  });
}

export interface ExecuteOptions {
  readonly writePreviews: boolean;
  readonly previewsDir: string;
  readonly json: boolean;
  readonly resolveCc?: (params: { readonly required: boolean }) => Promise<readonly EmailAddress[]>;
}

export async function executeSelection(
  ctx: CliContext,
  selection: SendSelection,
  options: ExecuteOptions,
): Promise<number> {
  const controller = new AbortController();
  const stopHandlingInterrupts = handleInterrupts(process, {
    onFirst: () => {
      ctx.out.warn('stopping: sends in flight will finish, nothing else is sent (press Ctrl-C again to quit now)');
      controller.abort();
    },
    onSecond: () => process.exit(EXIT.interrupted),
  });

  let results: readonly TemplateRunResult[];

  try {
    const integrations = await ctx.loadIntegrations(ctx.cwd);

    results = await runSelection(selection, {
      campaignsRoot: ctx.campaignsRoot,
      integrations,
      logger: new ConsoleLogger({ level: ctx.logLevel }),
      env: ctx.env,
      signal: controller.signal,
      signIn: ctx.interactive ? 'device-code' : 'cached-only',
      onSignInMessage: (message) => {
        ctx.out.info(message);
      },
      ...(options.writePreviews ? { previewDir: options.previewsDir } : {}),
      ...(options.resolveCc !== undefined ? { resolveCc: options.resolveCc } : {}),
    });
  } catch (error) {
    if (error instanceof RunInterruptedError) {
      const reason = error.cause instanceof Error ? error.cause.message : 'unknown error';

      report(ctx, selection, error.completed, options.json, { reason, notRun: error.notRun });
    }

    const cause = error instanceof RunInterruptedError ? error.cause : error;

    if (controller.signal.aborted && cause instanceof RunCancelledError) {
      ctx.out.warn('stopped before every list was processed; the rest stay pending for the next run');

      return EXIT.interrupted;
    }

    throw error;
  } finally {
    stopHandlingInterrupts();
  }

  report(ctx, selection, results, options.json);

  if (controller.signal.aborted) {
    return EXIT.interrupted;
  }

  return results.some((r) => needsAttention(r.report)) ? EXIT.attention : EXIT.ok;
}

function report(
  ctx: CliContext,
  selection: SendSelection,
  results: readonly TemplateRunResult[],
  json: boolean,
  interruption?: Interruption,
): void {
  if (json) {
    ctx.out.json(summaryJson(selection, results, interruption));
  } else {
    printSummary(ctx.out, selection, results, interruption);
  }
}

async function promptForCc(ctx: CliContext, params: { readonly required: boolean }): Promise<readonly EmailAddress[]> {
  if (!ctx.interactive) {
    throw new CliError(
      'no --cc given and no terminal to ask for one; pass --cc <email[,email...]> (or --cc "" for none)',
    );
  }

  const { inquirerCcPrompts } = await import('../cc-prompts');

  return resolveCcInteractive({
    envRaw: ctx.env['CC_RECIPIENT'],
    required: params.required,
    prompts: inquirerCcPrompts,
  });
}
