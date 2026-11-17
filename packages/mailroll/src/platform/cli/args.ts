import {
  ConfigError,
  type EmailAddress,
  parseEmailAddress,
  type ResendPolicy,
  type RunMode,
  type SendSelection,
  type TemplateTarget,
} from '@mailroll/core';
import { parseCcList } from './cc';
import { CliError } from './cli-error';
import { buildSelection } from '../composition/build-selection';

export interface ParsedCli {
  readonly selection: SendSelection;
  readonly writePreviews: boolean;
  readonly previewsDir: string;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildTargets(templateIds: readonly string[], dataFiles: readonly string[]): TemplateTarget[] {
  if (dataFiles.length === 0) {
    return templateIds.map((templateId) => ({ templateId }));
  }

  return templateIds.flatMap((templateId) => dataFiles.map((dataFile) => ({ templateId, dataFile })));
}

function toAddresses(values: readonly string[]): EmailAddress[] {
  return values.map((value) => {
    const outcome = parseEmailAddress(value);

    if (!outcome.ok) {
      throw new CliError(`invalid --recipients address "${value}": ${outcome.reasons.join('; ')}`);
    }

    return outcome.value;
  });
}

function parseMode(
  mode: string | undefined,
  to: string | undefined,
  confirm: boolean,
  testRecipientFallback: string | undefined,
): RunMode {
  switch (mode) {
    case 'dry-run':
      return { kind: 'dry-run' };
    case 'test': {
      const address = to ?? testRecipientFallback;

      if (address === undefined) {
        throw new CliError('test mode requires --to <address> or TEST_RECIPIENT in the environment');
      }

      const outcome = parseEmailAddress(address);

      if (!outcome.ok) {
        throw new CliError(`invalid test recipient "${address}": ${outcome.reasons.join('; ')}`);
      }

      return { kind: 'test', testRecipient: outcome.value };
    }

    case 'live':
      if (!confirm) {
        throw new CliError('live mode requires --confirm to prevent an accidental real send');
      }

      return { kind: 'live' };
    case undefined:
      throw new CliError('missing --mode <dry-run|test|live>');
    default:
      throw new CliError(`unknown --mode "${mode}" (expected dry-run, test, or live)`);
  }
}

function parsePolicy(policy: string | undefined, recipients: string | undefined): ResendPolicy {
  switch (policy) {
    case undefined:
    case 'pending':
      return { kind: 'pending' };
    case 'failed-only':
      return { kind: 'failed-only' };
    case 'force-all':
      return { kind: 'force-all' };
    case 'subset':
      return { kind: 'subset', recipients: toAddresses(splitCsv(recipients)) };
    default:
      throw new CliError(`unknown --policy "${policy}"`);
  }
}

function rejectInapplicable(values: SendOptionValues): void {
  if (values.recipients !== undefined && values.policy !== 'subset') {
    throw new CliError('--recipients only applies to --policy subset');
  }

  if (values.to !== undefined && values.mode !== 'test') {
    throw new CliError('--to only applies to --mode test');
  }

  if (values.confirm === true && values.mode !== 'live') {
    throw new CliError('--confirm only applies to --mode live');
  }

  if (values.writePreviews === true && values.mode !== 'dry-run') {
    throw new CliError('--write-previews only applies to --mode dry-run');
  }

  if (values.previewsDir !== undefined && values.writePreviews !== true) {
    throw new CliError('--previews-dir only applies to --write-previews');
  }

  if (values.previewsDir?.trim() === '') {
    throw new CliError('--previews-dir needs a folder name');
  }
}

export interface SendOptionValues {
  readonly campaign?: string | undefined;
  readonly template?: string | undefined;
  readonly data?: string | undefined;
  readonly cc?: string | undefined;
  readonly connection?: string | undefined;
  readonly policy?: string | undefined;
  readonly recipients?: string | undefined;
  readonly mode?: string | undefined;
  readonly to?: string | undefined;
  readonly confirm?: boolean | undefined;
  readonly writePreviews?: boolean | undefined;
  readonly previewsDir?: string | undefined;
}

export function selectionFromValues(values: SendOptionValues, env: NodeJS.ProcessEnv = process.env): ParsedCli {
  if (values.campaign === undefined) {
    throw new CliError('missing --campaign <group/name>');
  }

  if (values.template === undefined) {
    throw new CliError('missing --template <id[,id...]>');
  }

  if (values.connection === undefined) {
    throw new CliError('missing --connection <id[,id...]>');
  }

  const cc = values.cc !== undefined ? parseCcList(values.cc) : undefined;

  rejectInapplicable(values);

  const campaignId = values.campaign;
  const templateIds = values.template;
  const connections = values.connection;
  const selection = toCliError(() =>
    buildSelection({
      campaignId,
      targets: buildTargets(splitCsv(templateIds), splitCsv(values.data)),
      connectionIds: splitCsv(connections),
      policy: parsePolicy(values.policy, values.recipients),
      mode: parseMode(values.mode, values.to, values.confirm ?? false, env['TEST_RECIPIENT']),
      ...(cc !== undefined ? { cc } : {}),
    }),
  );

  return { selection, writePreviews: values.writePreviews ?? false, previewsDir: values.previewsDir ?? 'previews' };
}

function toCliError<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new CliError(error.message, { cause: error });
    }

    throw error;
  }
}
