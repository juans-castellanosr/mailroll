import { CliError } from '../cli-error';
import { type CliContext, EXIT } from '../context';
import { executeSelection } from './send';
import { loadTemplatePlugin } from '../../composition/load-template-plugin';
import { FileStateStore } from '../../state/file-state-store';

export async function menuCommand(ctx: CliContext): Promise<number> {
  if (!ctx.interactive) {
    throw new CliError(
      'the interactive menu needs a terminal; in scripts use "mailroll send" (see mailroll send --help)',
    );
  }

  const [{ runMenu }, { inquirerMenuPrompts }, { inquirerCcPrompts }] = await Promise.all([
    import('../../menu/run-menu'),
    import('../../menu/inquirer-menu-prompts'),
    import('../cc-prompts'),
  ]);
  const outcome = await runMenu({
    campaignsRoot: ctx.campaignsRoot,
    prompts: inquirerMenuPrompts,
    ccPrompts: inquirerCcPrompts,
    store: new FileStateStore(),
    loadPlugin: loadTemplatePlugin,
    env: ctx.env,
    random: Math.random,
  });

  if (outcome.kind === 'cancelled') {
    ctx.out.info('Canceled — nothing was sent.');

    return EXIT.ok;
  }

  return executeSelection(ctx, outcome.selection, {
    writePreviews: outcome.writePreviews,
    previewsDir: 'previews',
    json: false,
  });
}
