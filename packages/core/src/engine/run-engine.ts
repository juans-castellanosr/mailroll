import type { SenderCapabilities } from '../contracts/sender';
import { type ValidatedPreparedSender, validateSenderCapabilities } from '../contracts/validate-descriptor';
import { settleSend } from '../contracts/validate-send-outcome';
import { type EmailAddress, normalizeEmail } from '../domain/addressing/email-address';
import { requireEmailAddress, requireEmailAddresses } from '../domain/addressing/require-email-address';
import { DEFAULT_PACING, problemsOfPacing } from '../domain/catalog/pacing';
import { ConfigError, errorSummary } from '../domain/kernel/errors';
import { optionalField } from '../domain/kernel/optional-field';
import { readFields } from '../domain/kernel/read-untrusted';
import type { Message } from '../domain/messaging/message';
import type { Recipient } from '../domain/addressing/recipient';
import type { RenderedEmail } from '../domain/messaging/rendered-email';
import type { RunMode } from '../domain/run/run-mode';
import type { ResendPolicy } from '../domain/run/send-selection';
import type { SendResult } from '../domain/run/send-result';
import type { ResolvedTemplate } from '../domain/catalog/template';
import {
  type RecipientJournalEntry,
  type RecipientStatus,
  type TemplateState,
  settleStatus,
  upgradeTemplateState,
} from '../domain/run/template-state';
import { connectionCapabilityProblem, messageCapabilityProblem } from './check-capabilities';
import { collectRecipients } from './collect-recipients';
import { type ConnectionSender, type Delivery, type RetryPolicy, deliver } from './deliver';
import { recipientEntry } from './recipient-entry';
import { type RecipientWriteStage, toPersistenceError } from './persistence-failure';
import type { Assignment } from './distribute';
import { legacyProviderSender } from './legacy-provider-sender';
import { planRun } from './plan-run';
import { type RunReport, report } from './report';
import { TemplateRunError } from './template-run-error';
import type { DataSource } from '../ports/data-source';
import type { EmailProvider } from '../ports/email-provider';
import type { Logger } from '../ports/logger';
import type { RecipientValidator } from '../ports/recipient-validator';
import type { Sleeper } from '../ports/sleeper';
import type { StateStore } from '../ports/state-store';
import type { TemplateRenderer } from '../ports/template-renderer';

export interface RunTemplateDeps<T extends Recipient> {
  readonly template: ResolvedTemplate;
  readonly source: DataSource;
  readonly validator: RecipientValidator<T>;
  readonly renderer: TemplateRenderer<T>;
  readonly providers: ReadonlyMap<string, EmailProvider>;
  readonly connectionIds: readonly string[];
  readonly policy: ResendPolicy;
  readonly mode: RunMode;
  readonly delayBetweenSendsMs: number;
  readonly stateStore: StateStore;
  readonly logger: Logger;
  readonly sleeper: Sleeper;
  readonly now: () => string;
  readonly cc?: readonly EmailAddress[];
  readonly signal?: AbortSignal;
  readonly senders?: ReadonlyMap<string, PreparedConnectionSender>;
  readonly newAttemptId?: () => string;
}

export interface PreparedConnectionSender {
  readonly capabilities: SenderCapabilities;
  readonly sender: ValidatedPreparedSender;
}

interface ConnectionBinding {
  readonly sender: ConnectionSender;
  readonly retry: RetryPolicy;
  readonly capabilities: SenderCapabilities | undefined;
  readonly newAttemptId: (() => string) | undefined;
}

class StateCommitter {
  private readonly recipients: Map<string, RecipientStatus>;
  private readonly openIntents = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private lastOutcomeAt: string;

  constructor(
    private readonly store: StateStore,
    private readonly template: ResolvedTemplate,
    initial: TemplateState,
    private readonly now: () => string,
    private readonly active: boolean,
  ) {
    this.recipients = active ? new Map(Object.entries(initial.recipients)) : new Map<string, RecipientStatus>();
    this.lastOutcomeAt = initial.updatedAt;
  }

  assertNewAttempt(recipient: EmailAddress, attemptId: string | undefined): void {
    const status = this.recipients.get(normalizeEmail(recipient));
    const known =
      status === undefined
        ? []
        : [
            status.attemptId,
            status.status === 'failed' ? undefined : status.resendFailure?.attemptId,
            ...(status.uncertainAttemptIds ?? []),
          ];

    if (attemptId !== undefined && known.includes(attemptId)) {
      throw new ConfigError(
        `attempt id "${attemptId}" is already recorded for ${recipient}; newAttemptId must not repeat ids`,
      );
    }
  }

  intent(recipient: EmailAddress, connectionId: string, attemptId: string | undefined): Promise<void> {
    const email = normalizeEmail(recipient);

    this.openIntents.add(email);

    return this.write({
      email,
      intent: { at: this.now(), connectionId, ...optionalField('attemptId', attemptId) },
    });
  }

  async release(recipient: EmailAddress): Promise<void> {
    const email = normalizeEmail(recipient);

    await this.write({ email, released: { at: this.now() } });
    this.openIntents.delete(email);
  }

  commit(result: SendResult): Promise<void> {
    const entry = this.active ? recipientEntry(result) : undefined;

    if (entry === undefined) {
      return this.chain;
    }

    const [email, next] = entry;
    const status = settleStatus(this.recipients.get(email), next);

    this.recipients.set(email, status);
    this.lastOutcomeAt = status.at;

    return this.write({ email, status }).then(() => {
      this.openIntents.delete(email);
    });
  }

  async flush(): Promise<boolean> {
    await this.chain.catch(() => undefined);

    if (this.active && this.openIntents.size > 0) {
      return false;
    }

    if (this.active) {
      await this.store.compact(this.template, {
        version: 2,
        templateId: this.template.id,
        recipients: Object.fromEntries(this.recipients),
        updatedAt: this.lastOutcomeAt,
      });
    }

    return true;
  }

  private write(entry: RecipientJournalEntry): Promise<void> {
    if (!this.active) {
      return this.chain;
    }

    this.chain = this.chain.then(() => this.store.append(this.template, entry));

    return this.chain;
  }
}

const liveRuns = new WeakMap<StateStore, Set<string>>();

function reserveLiveRun(store: StateStore, template: ResolvedTemplate): () => void {
  const running = liveRuns.get(store) ?? new Set<string>();

  if (running.has(template.statePath)) {
    throw new ConfigError(
      `the send state of "${template.id}" · ${template.dataFile} is already used by another live run of this state store; nothing was sent`,
    );
  }

  running.add(template.statePath);
  liveRuns.set(store, running);

  return () => {
    running.delete(template.statePath);

    if (running.size === 0) {
      liveRuns.delete(store);
    }
  };
}

export async function runTemplate<T extends Recipient>(input: RunTemplateDeps<T>): Promise<RunReport> {
  const release = input.mode.kind === 'live' ? reserveLiveRun(input.stateStore, input.template) : undefined;

  try {
    return await runReservedTemplate(input);
  } finally {
    release?.();
  }
}

async function runReservedTemplate<T extends Recipient>(input: RunTemplateDeps<T>): Promise<RunReport> {
  const deps = withCheckedAddresses(input);
  const { template, logger, mode } = deps;

  const senders = checkSenderBindings(deps);
  const newAttemptId = uniqueAttemptIds(deps.newAttemptId ?? webAttemptIds());

  logger.info('template.start', {
    campaignId: template.campaignId,
    templateId: template.id,
    mode: mode.kind,
    connections: deps.connectionIds.join(','),
  });

  const { valid, skips } = await collectRecipients(deps.source, deps.validator);

  if (valid.length === 0) {
    logger.warn('source.empty', { campaignId: template.campaignId, templateId: template.id });
  }

  const state = upgradeTemplateState(await deps.stateStore.load(template));
  const plan = planRun({
    recipients: valid.map((v) => v.email),
    state,
    policy: deps.policy,
    connectionIds: deps.connectionIds,
  });

  const byEmail = new Map<string, T>(valid.map((v) => [normalizeEmail(v.email), v.recipient]));
  const committer = new StateCommitter(deps.stateStore, template, state, deps.now, mode.kind === 'live');

  const abort = new AbortController();
  const onExternalAbort = (): void => {
    abort.abort();
  };

  if (deps.signal?.aborted === true) {
    abort.abort();
  }

  deps.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let fatal: unknown;
  const groups = groupByConnection(plan.assignments);
  const perConnection = [...groups.keys()].map((): SendResult[] => []);

  await Promise.all(
    [...groups.entries()].map(([connectionId, assignments], index) =>
      runConnectionQueue(
        connectionId,
        bindingFor(connectionId, deps, senders, newAttemptId, abort.signal),
        assignments,
        byEmail,
        deps,
        committer,
        abort.signal,
        perConnection[index] ?? [],
      ).catch((error: unknown): void => {
        fatal ??= error;
        abort.abort();

        const queue = perConnection[index];

        if (queue !== undefined) {
          queue.push(...unreached(assignments, queue, 'run stopped by an error before this send; not attempted'));
        }
      }),
    ),
  );

  deps.signal?.removeEventListener('abort', onExternalAbort);

  try {
    const compacted = await committer.flush();

    if (!compacted) {
      logger.warn('state.journal_kept', { templateId: template.id, reason: 'an intent is still open' });
    }
  } catch (error) {
    if (fatal === undefined) {
      throw toPersistenceError(error, 'compact', undefined);
    }

    logger.error('state.flush_failed', { templateId: template.id, error: errorSummary(error) });
  }

  const summary = report([...skips, ...plan.skipped, ...perConnection.flat()]);

  if (fatal !== undefined) {
    throw new TemplateRunError(`run of "${template.id}" stopped: ${errorSummary(fatal)}`, summary, { cause: fatal });
  }

  logger.info('template.summary', {
    campaignId: template.campaignId,
    templateId: template.id,
    sent: summary.sent,
    failed: summary.failed,
    uncertain: summary.uncertain,
    notAttempted: summary.notAttempted,
    skipped: summary.skipped,
    total: summary.total,
  });

  return summary;
}

function groupByConnection(assignments: readonly Assignment[]): Map<string, Assignment[]> {
  const groups = new Map<string, Assignment[]>();

  for (const assignment of assignments) {
    const existing = groups.get(assignment.connectionId);

    if (existing === undefined) {
      groups.set(assignment.connectionId, [assignment]);
    } else {
      existing.push(assignment);
    }
  }

  return groups;
}

async function runConnectionQueue<T extends Recipient>(
  connectionId: string,
  binding: ConnectionBinding | undefined,
  assignments: readonly Assignment[],
  byEmail: ReadonlyMap<string, T>,
  deps: RunTemplateDeps<T>,
  committer: StateCommitter,
  signal: AbortSignal,
  results: SendResult[],
): Promise<void> {
  if (binding === undefined) {
    results.push(
      ...assignments.map((a) => notAttempted(a.recipient, `no provider bound for connection "${connectionId}"`)),
    );

    return;
  }

  const unusable =
    binding.capabilities === undefined
      ? undefined
      : connectionCapabilityProblem(binding.capabilities, deps.cc, deps.template);

  if (unusable !== undefined) {
    deps.logger.error('connection.incapable', { connectionId, reason: unusable, unattempted: assignments.length });
    results.push(
      ...remainingNotAttempted(
        assignments,
        0,
        `connection "${connectionId}" cannot send this list: ${unusable}; not attempted`,
      ),
    );

    return;
  }

  let consecutiveUncertain = 0;

  for (const [i, assignment] of assignments.entries()) {
    if (i > 0 && deps.mode.kind !== 'dry-run' && deps.delayBetweenSendsMs > 0) {
      await deps.sleeper.sleep(deps.delayBetweenSendsMs, signal);
    }

    if (signal.aborted) {
      results.push(...remainingNotAttempted(assignments, i, 'run stopped before this send; not attempted'));
      break;
    }

    const recipient = byEmail.get(normalizeEmail(assignment.recipient));

    if (recipient === undefined) {
      results.push(notAttempted(assignment.recipient, 'recipient is not in the validated list; not attempted'));
      continue;
    }

    const to = deps.mode.kind === 'test' ? deps.mode.testRecipient : assignment.recipient;
    const message = buildMessage(to, deps.renderer.render(recipient), deps.cc);
    const unsendable =
      binding.capabilities === undefined ? undefined : messageCapabilityProblem(binding.capabilities, message);

    if (unsendable !== undefined) {
      deps.logger.error('recipient.incapable', { connectionId, email: assignment.recipient, reason: unsendable });
      results.push(notAttempted(assignment.recipient, `${unsendable}; not attempted`));
      continue;
    }

    const attemptId = binding.newAttemptId?.();
    const where = { connectionId, email: assignment.recipient, ...optionalField('attemptId', attemptId) };

    committer.assertNewAttempt(assignment.recipient, attemptId);
    await persist(() => committer.intent(assignment.recipient, connectionId, attemptId), 'intent', where, deps);
    const delivery = await deliver(binding.sender, message, {
      attemptId: attemptId ?? '',
      preferences: { keepSentCopy: deps.template.saveToSentItems === true },
      retry: binding.retry,
      sleeper: deps.sleeper,
      signal,
      random: Math.random,
    });

    if (delivery.kind === 'stop-connection' || delivery.kind === 'cancelled') {
      const reason = reportStop(delivery, where, deps, assignments.length - i);

      await persist(() => committer.release(assignment.recipient), 'release', where, deps);
      results.push(...remainingNotAttempted(assignments, i, reason));
      break;
    }

    const result = reportDelivery(delivery, where, deps);

    results.push(result);
    await persist(() => committer.commit(result), 'outcome', where, deps);

    consecutiveUncertain = result.status === 'uncertain' ? consecutiveUncertain + 1 : 0;
    if (consecutiveUncertain >= MAX_CONSECUTIVE_UNCERTAIN) {
      const reason = `connection "${connectionId}" stopped after ${String(MAX_CONSECUTIVE_UNCERTAIN)} uncertain sends in a row (provider outage?); not attempted`;

      deps.logger.error('connection.stopped_uncertain', { connectionId, unattempted: assignments.length - i - 1 });
      results.push(...remainingNotAttempted(assignments, i + 1, reason));
      break;
    }
  }
}

const MAX_CONSECUTIVE_UNCERTAIN = 3;

function remainingNotAttempted(assignments: readonly Assignment[], from: number, reason: string): SendResult[] {
  return assignments.slice(from).map((a) => notAttempted(a.recipient, reason));
}

function unreached(assignments: readonly Assignment[], results: readonly SendResult[], reason: string): SendResult[] {
  const reached = new Set(
    results.flatMap((result) => (result.status === 'skipped' ? [] : [normalizeEmail(result.recipient)])),
  );

  return assignments
    .filter((assignment) => !reached.has(normalizeEmail(assignment.recipient)))
    .map((assignment) => notAttempted(assignment.recipient, reason));
}

type RecordedDelivery = Exclude<Delivery, { readonly kind: 'stop-connection' } | { readonly kind: 'cancelled' }>;

interface SendPlace {
  readonly connectionId: string;
  readonly email: EmailAddress;
  readonly attemptId?: string;
}

function reportDelivery<T extends Recipient>(
  delivery: RecordedDelivery,
  where: SendPlace,
  deps: RunTemplateDeps<T>,
): SendResult {
  const { connectionId, email: recipient } = where;
  const attempt = optionalField('attemptId', where.attemptId);

  switch (delivery.kind) {
    case 'sent':
      if (delivery.ccRejected !== undefined && delivery.ccRejected.length > 0) {
        deps.logger.warn('recipient.cc_rejected', { ...where, cc: delivery.ccRejected.join(',') });
      }

      deps.logger.info(deps.mode.kind === 'dry-run' ? 'recipient.rendered' : 'recipient.sent', { ...where });

      return {
        status: 'sent',
        recipient,
        connectionId,
        at: deps.now(),
        ...attempt,
        ...optionalField('providerMessageId', delivery.providerMessageId),
        ...(delivery.ccRejected === undefined
          ? {}
          : { cc: { rejected: delivery.ccRejected, required: deps.template.ccPolicy === 'required' } }),
      };
    case 'uncertain':
      deps.logger.error('recipient.uncertain', { ...where, error: delivery.message });

      return { status: 'uncertain', recipient, connectionId, message: delivery.message, at: deps.now(), ...attempt };
    case 'failed':
      deps.logger.error('recipient.failed', { ...where, category: delivery.category, error: delivery.message });

      return {
        status: 'failed',
        recipient,
        connectionId,
        category: delivery.category,
        message: delivery.message,
        at: deps.now(),
        ...attempt,
      };
  }
}

function reportStop<T extends Recipient>(
  delivery: Extract<Delivery, { readonly kind: 'stop-connection' } | { readonly kind: 'cancelled' }>,
  where: SendPlace,
  deps: RunTemplateDeps<T>,
  unattempted: number,
): string {
  const { connectionId } = where;

  if (delivery.kind === 'cancelled') {
    return delivery.waited
      ? 'run stopped while this send was waiting to retry; not attempted'
      : 'run stopped before this send; not attempted';
  }

  if (delivery.auth) {
    deps.logger.error('recipient.auth_failed', { ...where, error: delivery.message });
    deps.logger.error('connection.quarantined', { connectionId, unattempted });

    return `connection "${connectionId}" quarantined (authentication failed); not attempted`;
  }

  deps.logger.error('connection.stopped', { connectionId, unattempted, error: delivery.message });

  return `connection "${connectionId}" stopped (${delivery.message}); not attempted`;
}

interface CheckedSender {
  readonly capabilities: SenderCapabilities;
  readonly sender: ConnectionSender;
}

function bindingFor<T extends Recipient>(
  connectionId: string,
  deps: RunTemplateDeps<T>,
  senders: ReadonlyMap<string, CheckedSender>,
  newAttemptId: (() => string) | undefined,
  signal: AbortSignal,
): ConnectionBinding | undefined {
  const checked = senders.get(connectionId);

  if (checked !== undefined) {
    return {
      sender: checked.sender,
      retry: { kind: 'core', pacing: deps.template.pacing ?? DEFAULT_PACING },
      capabilities: checked.capabilities,
      newAttemptId,
    };
  }

  const provider = deps.providers.get(connectionId);

  return provider === undefined
    ? undefined
    : {
        sender: legacyProviderSender(provider, signal),
        retry: { kind: 'inside-provider' },
        capabilities: undefined,
        newAttemptId: undefined,
      };
}

function checkSenderBindings<T extends Recipient>(deps: RunTemplateDeps<T>): ReadonlyMap<string, CheckedSender> {
  const senderIds = [...(deps.senders?.keys() ?? [])];

  if (senderIds.length === 0) {
    return new Map();
  }

  const both = senderIds.filter((id) => deps.providers.has(id));

  if (both.length > 0) {
    throw new ConfigError(
      `connection(s) ${both.map((id) => `"${id}"`).join(', ')} are bound both to an email provider and to a sender; bind each connection once`,
    );
  }

  if (deps.mode.kind === 'dry-run') {
    throw new ConfigError('a dry run never uses senders, because they send for real; bind preview providers instead');
  }

  const pacingProblems = deps.template.pacing === undefined ? [] : problemsOfPacing(deps.template.pacing);

  if (pacingProblems.length > 0) {
    throw new ConfigError(`template "${deps.template.id}" has an invalid pacing: ${pacingProblems.join('; ')}`);
  }

  if (deps.newAttemptId === undefined && webAttemptIds() === undefined) {
    throw new ConfigError('this runtime cannot generate attempt ids (crypto.randomUUID is missing); pass newAttemptId');
  }

  return new Map(senderIds.map((id) => [id, checkedSender(id, deps.senders?.get(id))]));
}

function checkedSender(connectionId: string, raw: unknown): CheckedSender {
  const entry = readFields(raw, ['capabilities', 'sender']);
  const target = entry.ok ? entry.fields['sender'] : undefined;
  const sender = readFields(target, ['send']);
  const send = sender.ok ? sender.fields['send'] : undefined;
  const capabilities = validateSenderCapabilities(entry.ok ? entry.fields['capabilities'] : undefined);
  const reasons = [
    ...(entry.ok ? [] : [`the binding ${entry.error}`]),
    ...(typeof send === 'function' ? [] : ['"sender.send" must be a function']),
    ...(capabilities.ok ? [] : capabilities.reasons),
  ];

  if (reasons.length > 0 || !capabilities.ok || typeof send !== 'function') {
    throw new ConfigError(`the sender bound to connection "${connectionId}" is invalid: ${reasons.join('; ')}`);
  }

  return {
    capabilities: capabilities.value,
    sender: {
      send: (message, attempt, preferences) =>
        settleSend((): unknown => Reflect.apply(send, target, [message, attempt, preferences]), {
          capabilities: capabilities.value,
          message,
        }),
    },
  };
}

function uniqueAttemptIds(generate: (() => string) | undefined): (() => string) | undefined {
  const issued = new Set<string>();

  return generate === undefined
    ? undefined
    : (): string => {
        const id: unknown = generate();

        if (typeof id !== 'string' || id.trim().length === 0 || issued.has(id)) {
          throw new ConfigError('newAttemptId must return a new, non-empty text id for every send');
        }

        issued.add(id);

        return id;
      };
}

function webAttemptIds(): (() => string) | undefined {
  const crypto: unknown = Reflect.get(globalThis, 'crypto');
  const randomUUID: unknown =
    typeof crypto === 'object' && crypto !== null ? Reflect.get(crypto, 'randomUUID') : undefined;

  return typeof randomUUID === 'function' ? (): string => String(Reflect.apply(randomUUID, crypto, [])) : undefined;
}

async function persist<T extends Recipient>(
  write: () => Promise<void>,
  stage: RecipientWriteStage,
  where: SendPlace,
  deps: RunTemplateDeps<T>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    deps.logger.error('recipient.unrecorded', {
      templateId: deps.template.id,
      ...where,
      stage,
      error: errorSummary(error),
    });

    throw toPersistenceError(error, stage, where.email);
  }
}

function notAttempted(recipient: EmailAddress, reason: string): SendResult {
  return { status: 'not-attempted', recipient, reason };
}

function buildMessage(to: EmailAddress, rendered: RenderedEmail, cc?: readonly EmailAddress[]): Message {
  return {
    to,
    subject: rendered.subject,
    html: rendered.html,
    ...(cc !== undefined && cc.length > 0 ? { cc } : {}),
    ...(rendered.inlineAttachments !== undefined ? { inlineAttachments: rendered.inlineAttachments } : {}),
  };
}

function withCheckedAddresses<T extends Recipient>(deps: RunTemplateDeps<T>): RunTemplateDeps<T> {
  const { mode, policy, cc } = deps;
  const checkedMode: RunMode =
    mode.kind === 'test'
      ? { kind: 'test', testRecipient: requireEmailAddress(mode.testRecipient, 'mode.testRecipient') }
      : mode;
  const checkedPolicy: ResendPolicy =
    policy.kind === 'subset'
      ? { kind: 'subset', recipients: requireEmailAddresses(policy.recipients, 'policy.recipients') }
      : policy;

  return {
    ...deps,
    mode: checkedMode,
    policy: checkedPolicy,
    ...(cc !== undefined ? { cc: requireEmailAddresses(cc, 'cc') } : {}),
  };
}
