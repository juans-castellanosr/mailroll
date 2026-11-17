import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type Campaign,
  ConfigError,
  type Connection,
  DEFAULT_PACING,
  type EmailAddress,
  type EmailProvider,
  type Logger,
  MailrollError,
  type Pacing,
  type PreparedConnectionSender,
  type PreparedTemplate,
  type ResendPolicy,
  type ResolvedTemplate,
  RunCancelledError,
  type RunReport,
  type SendSelection,
  type StateLock,
  TemplateRunError,
  type ValidatedIntegration,
} from '@mailroll/core';
import { NullEmailProvider } from '../../integrations/providers/preview/null-email-provider';
import { PreviewEmailProvider } from '../../integrations/providers/preview/preview-email-provider';
import { buildSelection } from './build-selection';
import { activateIntegrations } from './integrations';
import { recipientSource } from './recipient-source';
import { fileFingerprint } from './file-fingerprint';
import { resolveDataFile, resolveTemplate } from './resolve-template';
import { resolveDeclaredSecrets } from '../config/resolve-connection-secrets';
import { safeSegment } from '../config/connection-key';
import { connectionStateLocation } from '../config/connection-state-location';
import { discoverCampaigns } from '../discovery/discover-campaigns';
import { loadTemplatePlugin } from './load-template-plugin';
import { resolveCc } from './resolve-cc';
import { FileStateStore } from '../state/file-state-store';
import {
  confirmUpgrade,
  type HistoryInspection,
  type HistoryPresence,
  type HistoryUpgrade,
  inspectHistory,
} from '../state/history-presence';
import { SystemSleeper } from '../time/system-sleeper';

export interface RunSelectionOptions {
  readonly campaignsRoot: string;
  readonly logger: Logger;
  readonly previewDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly resolveCc?: (params: { readonly required: boolean }) => Promise<readonly EmailAddress[]>;
  readonly signal?: AbortSignal;
  readonly integrations?: readonly unknown[];
  readonly signIn?: 'device-code' | 'cached-only';
  readonly onSignInMessage?: (message: string) => void;
}

type SenderBindings = ReadonlyMap<string, PreparedConnectionSender>;

export interface TemplateRunResult {
  readonly templateId: string;
  readonly dataFile: string;
  readonly policy: ResendPolicy['kind'];
  readonly statePath: string;
  readonly previewDir?: string;
  readonly report: RunReport;
  readonly history: RunHistory;
}

export type RunHistory =
  | { readonly before: HistoryPresence; readonly upgraded: false; readonly unconfirmed?: true }
  | { readonly before: 'v1'; readonly upgraded: true; readonly backups: readonly string[] };

export async function runSelection(input: SendSelection, options: RunSelectionOptions): Promise<TemplateRunResult[]> {
  const selection = buildSelection(input);
  const campaigns = await discoverCampaigns(options.campaignsRoot);
  const campaign = campaigns.find((c) => c.id === selection.campaignId);

  if (campaign === undefined) {
    throw new ConfigError(`campaign "${selection.campaignId}" not found`);
  }

  const stateStore = new FileStateStore();
  const integrations = activateIntegrations(options.integrations ?? []);
  const { targets, senders } = await prepareTargets(selection, campaign, options, stateStore, integrations);

  try {
    return await runPrepared(targets, selection, options, stateStore, senders);
  } finally {
    await releaseLocks(targets).catch((releaseError: unknown) => {
      options.logger.error('state.lock_release_failed', {
        error: releaseError instanceof Error ? releaseError.message : 'unknown',
      });
    });
    await closeSenders(senders, options.logger);
  }
}

export interface ListRef {
  readonly templateId: string;
  readonly dataFile: string;
}

export class RunInterruptedError extends MailrollError {
  constructor(
    message: string,
    readonly completed: readonly TemplateRunResult[],
    readonly notRun: readonly ListRef[],
    options: { readonly cause: unknown },
  ) {
    super(message, options);
  }
}

async function runPrepared(
  prepared: readonly PreparedTarget[],
  selection: SendSelection,
  options: RunSelectionOptions,
  stateStore: FileStateStore,
  senders: SenderBindings,
): Promise<TemplateRunResult[]> {
  const now = options.now ?? (() => new Date().toISOString());
  const results: TemplateRunResult[] = [];
  let current: { readonly target: PreparedTarget; readonly before: HistoryInspection } | undefined;

  try {
    for (const target of prepared) {
      if (options.signal?.aborted === true) {
        throw new RunCancelledError(`run canceled before ${target.resolved.id} · ${target.resolved.dataFile}`);
      }

      const before = await inspectHistory(target.resolved.statePath);

      current = { target, before };
      results.push(await runTarget(target, before, selection, options, stateStore, senders, now));
    }
  } catch (error) {
    const finished = results.length;

    if (error instanceof TemplateRunError && current !== undefined) {
      results.push(
        resultOf(
          current.target,
          error.report,
          await historyAfter(current.target, current.before, selection, options.logger),
        ),
      );
    }

    if (results.length === 0) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : 'unknown error';
    const notRun = prepared
      .slice(results.length)
      .map(({ resolved }) => ({ templateId: resolved.id, dataFile: resolved.dataFile }));

    throw new RunInterruptedError(
      `run stopped after ${String(finished)} of ${String(prepared.length)} list(s): ${reason}`,
      results,
      notRun,
      { cause: error },
    );
  }

  return results;
}

async function runTarget(
  target: PreparedTarget,
  before: HistoryInspection,
  selection: SendSelection,
  options: RunSelectionOptions,
  stateStore: FileStateStore,
  senders: SenderBindings,
  now: () => string,
): Promise<TemplateRunResult> {
  if ((await fileFingerprint(target.resolved.dataPath)) !== target.fingerprint) {
    throw new ConfigError(
      `${target.resolved.dataFile} of "${target.resolved.id}" changed after the run was prepared; nothing more was sent — run again`,
    );
  }

  options.logger.info('cc.resolved', {
    templateId: target.resolved.id,
    addresses: target.cc.length > 0 ? target.cc.join(', ') : '(none)',
  });

  if (target.previewDir !== undefined) {
    await rm(target.previewDir, { recursive: true, force: true });
  }

  const report = await target.template.run({
    template: target.resolved,
    source: recipientSource(target.resolved.dataPath),
    providers: selection.mode.kind === 'dry-run' ? previewProviders(target.connections, target.previewDir) : new Map(),
    senders: new Map(
      target.connections.flatMap((connection) => {
        const sender = senders.get(connection.id);

        return sender === undefined ? [] : [[connection.id, sender] as const];
      }),
    ),
    connectionIds: target.connections.map((c) => c.id),
    policy: target.policy,
    mode: selection.mode,
    delayBetweenSendsMs: target.pacing.delayBetweenSendsMs,
    stateStore,
    logger: options.logger,
    sleeper: new SystemSleeper(),
    now,
    ...(target.cc.length > 0 ? { cc: target.cc } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return resultOf(target, report, await historyAfter(target, before, selection, options.logger));
}

async function historyAfter(
  target: PreparedTarget,
  inspected: HistoryInspection,
  selection: SendSelection,
  logger: Logger,
): Promise<RunHistory> {
  const before = inspected.presence;

  if (selection.mode.kind !== 'live' || before !== 'v1') {
    return { before, upgraded: false };
  }

  let confirmed: HistoryUpgrade;

  try {
    confirmed = await confirmUpgrade(target.resolved.statePath, inspected);
  } catch (error) {
    logger.warn('state.history_check_failed', {
      templateId: target.resolved.id,
      dataFile: target.resolved.dataFile,
      error: error instanceof Error ? error.message : String(error),
    });

    return { before, upgraded: false, unconfirmed: true };
  }

  if (!confirmed.upgraded) {
    return { before, upgraded: false, unconfirmed: true };
  }

  logger.info('state.history_upgraded', {
    templateId: target.resolved.id,
    dataFile: target.resolved.dataFile,
    statePath: target.resolved.statePath,
    backups: confirmed.backups.join(', '),
  });

  return { before, upgraded: true, backups: confirmed.backups };
}

function resultOf(target: PreparedTarget, report: RunReport, history: RunHistory): TemplateRunResult {
  return {
    templateId: target.resolved.id,
    dataFile: target.resolved.dataFile,
    policy: target.policy.kind,
    statePath: target.resolved.statePath,
    ...(target.previewDir !== undefined ? { previewDir: target.previewDir } : {}),
    report,
    history,
  };
}

interface PreparedTarget {
  readonly resolved: ResolvedTemplate;
  readonly template: PreparedTemplate;
  readonly fingerprint: string;
  readonly lock?: StateLock;
  readonly connections: readonly Connection[];
  readonly pacing: Pacing;
  readonly policy: ResendPolicy;
  readonly cc: readonly EmailAddress[];
  readonly previewDir?: string;
}

interface DraftTarget extends Omit<PreparedTarget, 'cc' | 'lock'> {
  readonly ccInput: readonly EmailAddress[] | undefined;
}

async function prepareTargets(
  selection: SendSelection,
  campaign: Campaign,
  options: RunSelectionOptions,
  stateStore: FileStateStore,
  integrations: ReadonlyMap<string, ValidatedIntegration>,
): Promise<{ readonly targets: PreparedTarget[]; readonly senders: SenderBindings }> {
  const templatesById = new Map(campaign.templates.map((t) => [t.id, t]));
  const preparedTemplates = new Map<string, PreparedTemplate>();
  const drafts: DraftTarget[] = [];

  for (const target of selection.targets) {
    const template = templatesById.get(target.templateId);

    if (template === undefined) {
      throw new ConfigError(`template "${target.templateId}" not found in campaign "${campaign.id}"`);
    }

    for (const id of selection.connectionIds) {
      if (!campaign.connections.some((c) => c.id === id)) {
        throw new ConfigError(`connection "${id}" does not exist in campaign "${campaign.id}"`);
      }

      if (!template.connectionIds.includes(id)) {
        throw new ConfigError(
          `template "${template.id}" does not declare connection "${id}" (it declares: ${template.connectionIds.join(', ')})`,
        );
      }
    }

    const selectedIds = new Set(selection.connectionIds);
    const resolved = resolveTemplate(template, await resolveDataFile(template, target.dataFile));
    const previewDir =
      options.previewDir !== undefined && selection.mode.kind === 'dry-run'
        ? previewDirFor(options.previewDir, resolved)
        : undefined;

    let preparedTemplate = preparedTemplates.get(template.id);

    if (preparedTemplate === undefined) {
      preparedTemplate = await (await loadTemplatePlugin(template)).prepare(template);
      preparedTemplates.set(template.id, preparedTemplate);
    }

    const digest = await fileFingerprint(resolved.dataPath);

    if (target.dataFingerprint !== undefined && target.dataFingerprint !== digest) {
      throw new ConfigError(
        `${resolved.dataFile} of "${template.id}" changed after you reviewed it; nothing was sent — review it again`,
      );
    }

    await preparedTemplate.listRecipients(recipientSource(resolved.dataPath));
    await stateStore.load(resolved);

    drafts.push({
      resolved,
      template: preparedTemplate,
      fingerprint: digest,
      connections: campaign.connections.filter((c) => selectedIds.has(c.id)),
      pacing: template.pacing ?? DEFAULT_PACING,
      policy: target.policy ?? selection.policy,
      ccInput: target.cc ?? selection.cc ?? template.cc,
      ...(previewDir !== undefined ? { previewDir } : {}),
    });
  }

  rejectSharedPreviews(drafts);

  const connections = [...new Set(drafts.flatMap((d) => d.connections))];
  const sending = selection.mode.kind !== 'dry-run';
  const env = options.env ?? process.env;
  const plans = connections.map((connection) => {
    const integration = integrationFor(connection, integrations);

    return {
      connection,
      integration,
      settings: settingsOf(connection, integration),
      secrets: sending
        ? resolveDeclaredSecrets(campaign.id, connection.id, integration.configuration.secrets, env)
        : {},
    };
  });

  const asking = drafts.filter((d) => d.ccInput === undefined && d.resolved.ccPolicy !== 'forbidden');
  let prompted: readonly EmailAddress[] | undefined;

  if (asking.length > 0 && options.resolveCc !== undefined) {
    prompted = await options.resolveCc({
      required: selection.mode.kind === 'live' && asking.some((d) => d.resolved.ccPolicy === 'required'),
    });
  }

  const ready = drafts.map(({ ccInput, ...draft }) => ({
    ...draft,
    cc: resolveCc(
      draft.resolved.ccPolicy,
      ccInput ?? (draft.resolved.ccPolicy !== 'forbidden' ? prompted : undefined),
      selection.mode,
      draft.resolved.id,
    ),
  }));

  const senders = sending
    ? await prepareSenders(plans, campaign, options, env)
    : new Map<string, PreparedConnectionSender>();

  try {
    return {
      targets: selection.mode.kind === 'live' ? await lockAll(ready, stateStore, options.logger) : ready,
      senders,
    };
  } catch (error) {
    await closeSenders(senders, options.logger);
    throw error;
  }
}

interface ConnectionPlan {
  readonly connection: Connection;
  readonly integration: ValidatedIntegration;
  readonly settings: unknown;
  readonly secrets: Readonly<Record<string, string>>;
}

function integrationFor(
  connection: Connection,
  integrations: ReadonlyMap<string, ValidatedIntegration>,
): ValidatedIntegration {
  const integration = integrations.get(connection.kind);

  if (integration === undefined) {
    throw new ConfigError(
      `connection "${connection.id}" uses the integration "${connection.kind}", which is not active (active: ${[...integrations.keys()].join(', ') || 'none'})`,
    );
  }

  return integration;
}

function settingsOf(connection: Connection, integration: ValidatedIntegration): unknown {
  const outcome = integration.configuration.validateSettings(connection.settings);

  if (!outcome.ok) {
    throw new ConfigError(`invalid settings for connection "${connection.id}": ${outcome.reasons.join('; ')}`);
  }

  return outcome.value;
}

async function prepareSenders(
  plans: readonly ConnectionPlan[],
  campaign: Campaign,
  options: RunSelectionOptions,
  env: NodeJS.ProcessEnv,
): Promise<SenderBindings> {
  const senders = new Map<string, PreparedConnectionSender>();
  const signal = options.signal ?? new AbortController().signal;
  const announce = options.onSignInMessage ?? ((message: string) => process.stderr.write(`${message}\n`));

  try {
    for (const { connection, integration, settings, secrets } of plans) {
      const prepared = await integration.sender
        .prepare({
          connectionId: connection.id,
          from: connection.mailbox,
          ...(connection.displayName === undefined ? {} : { fromName: connection.displayName }),
          settings,
          secrets,
          ...connectionStateLocation({ env, campaignId: campaign.id, connectionId: connection.id }),
          interaction: { announce },
          interactive: options.signIn !== 'cached-only',
          signal,
          logger: options.logger,
        })
        .catch((error: unknown) => {
          if (signal.aborted) {
            throw new RunCancelledError(`run canceled while signing in to connection "${connection.id}"`);
          }

          throw error;
        });

      if (!prepared.ok) {
        throw new ConfigError(
          `the "${integration.id}" integration could not prepare connection "${connection.id}": ${prepared.reasons.join('; ')}`,
        );
      }

      senders.set(connection.id, { capabilities: integration.sender.capabilities, sender: prepared.value });
    }
  } catch (error) {
    await closeSenders(senders, options.logger);
    throw error;
  }

  return senders;
}

async function closeSenders(senders: SenderBindings, logger: Logger): Promise<void> {
  const closing = await Promise.allSettled([...senders.values()].map(({ sender }) => sender.close()));

  for (const outcome of closing) {
    if (outcome.status === 'rejected') {
      logger.error('integration.close_failed', {
        error: outcome.reason instanceof Error ? outcome.reason.message : 'unknown',
      });
    }
  }
}

async function lockAll(
  targets: readonly PreparedTarget[],
  stateStore: FileStateStore,
  logger: Logger,
): Promise<PreparedTarget[]> {
  const locked: PreparedTarget[] = [];

  try {
    for (const target of targets) {
      const lock = await stateStore.lock(target.resolved);

      if (lock.recoveredFrom !== undefined) {
        logger.warn('state.lock_recovered', {
          templateId: target.resolved.id,
          dataFile: target.resolved.dataFile,
          previousPid: lock.recoveredFrom.pid,
          previousStart: lock.recoveredFrom.startedAt,
        });
      }

      locked.push({ ...target, lock });
    }
  } catch (error) {
    await releaseLocks(locked);
    throw error;
  }

  return locked;
}

async function releaseLocks(targets: readonly PreparedTarget[]): Promise<void> {
  await Promise.all(targets.flatMap((target) => (target.lock !== undefined ? [target.lock.release()] : [])));
}

function previewDirFor(root: string, resolved: ResolvedTemplate): string {
  const templateSegment = safeSegment(resolved.id);

  if (templateSegment.length === 0) {
    throw new ConfigError(`template id "${resolved.id}" cannot be turned into a preview folder name`);
  }

  return join(root, templateSegment, basename(resolved.statePath, '.json'));
}

function rejectSharedPreviews(drafts: readonly DraftTarget[]): void {
  const owners = new Map<string, ResolvedTemplate>();

  for (const { previewDir, resolved } of drafts) {
    if (previewDir === undefined) {
      continue;
    }

    const other = owners.get(previewDir);

    if (other !== undefined) {
      throw new ConfigError(
        `"${other.id}" · ${other.dataFile} and "${resolved.id}" · ${resolved.dataFile} map to the same preview folder (${previewDir}); rename one of them`,
      );
    }

    owners.set(previewDir, resolved);
  }
}

function previewProviders(
  connections: readonly Connection[],
  previewDir: string | undefined,
): ReadonlyMap<string, EmailProvider> {
  const preview = previewDir !== undefined ? new PreviewEmailProvider(previewDir) : new NullEmailProvider();

  return new Map(connections.map((connection) => [connection.id, preview]));
}
