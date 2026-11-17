import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  INTEGRATION_KIND,
  type IntegrationDescriptor,
  type Message,
  parseEmailAddress,
  type PreparedConnectionSender,
  SENDER_CONTRACT,
  type SendAttempt,
  type SendOutcome,
  valid,
  validateIntegrationDescriptor,
} from '@mailroll/core';

export type LedgerOutcome = SendOutcome['outcome'];

export const LIST_MESSAGE = 'acme/onboarding · welcome · recipients.csv';

export interface LedgerCall {
  readonly run: string;
  readonly policy: string;
  readonly message: string;
  readonly to: string;
  readonly fingerprint: string;
  readonly attemptId: string;
  readonly call: number;
  readonly outcome: LedgerOutcome;
}

export interface AccidentalDuplicate {
  readonly to: string;
  readonly message: string;
  readonly runs: readonly string[];
  readonly fingerprints: readonly string[];
}

export interface LedgerSummary {
  readonly callsPerRecipient: Readonly<Record<string, number>>;
  readonly intentsPerRecipient: Readonly<Record<string, number>>;
  readonly accidentalDuplicates: readonly AccidentalDuplicate[];
}

const RESEND_POLICIES: ReadonlySet<string> = new Set(['force-all', 'subset']);
const POSSIBLY_DELIVERED: ReadonlySet<LedgerOutcome> = new Set(['accepted', 'unknown']);

export function fingerprintOf(message: Message): string {
  return createHash('sha256')
    .update(JSON.stringify([message.to, message.subject, message.html]))
    .digest('hex')
    .slice(0, 16);
}

function isLedgerCall(value: unknown): value is LedgerCall {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const fields: readonly (readonly [string, string])[] = [
    ['run', 'string'],
    ['policy', 'string'],
    ['message', 'string'],
    ['to', 'string'],
    ['fingerprint', 'string'],
    ['attemptId', 'string'],
    ['call', 'number'],
    ['outcome', 'string'],
  ];

  return fields.every(([name, type]) => typeof Reflect.get(value, name) === type);
}

export class SendLedger {
  constructor(readonly path: string) {}

  record(call: LedgerCall): void {
    appendFileSync(this.path, `${JSON.stringify(call)}\n`);
  }

  calls(): LedgerCall[] {
    if (!existsSync(this.path)) {
      return [];
    }

    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const parsed: unknown = JSON.parse(line);

        if (!isLedgerCall(parsed)) {
          throw new Error(`malformed ledger line: ${line}`);
        }

        return parsed;
      });
  }

  summary(): LedgerSummary {
    return summarize(this.calls());
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

export function summarize(calls: readonly LedgerCall[]): LedgerSummary {
  const intents = calls.filter(
    (call, index) =>
      calls.findIndex(
        (other) => other.run === call.run && other.attemptId === call.attemptId && other.to === call.to,
      ) === index,
  );
  const outcomeOfIntent = (intent: LedgerCall): LedgerOutcome =>
    calls
      .filter((call) => call.run === intent.run && call.attemptId === intent.attemptId && call.to === intent.to)
      .at(-1)?.outcome ?? intent.outcome;
  const groups = new Map<string, LedgerCall[]>();

  for (const intent of intents) {
    const key = `${intent.to}|${intent.message}`;

    groups.set(key, [...(groups.get(key) ?? []), intent]);
  }

  const accidentalDuplicates = [...groups.values()].flatMap((group): AccidentalDuplicate[] => {
    const unauthorized = group.filter(
      (intent, index) =>
        index > 0 &&
        !RESEND_POLICIES.has(intent.policy) &&
        group.slice(0, index).some((earlier) => POSSIBLY_DELIVERED.has(outcomeOfIntent(earlier))),
    );
    const first = group[0];

    return unauthorized.length === 0 || first === undefined
      ? []
      : [
          {
            to: first.to,
            message: first.message,
            runs: group.map((intent) => intent.run),
            fingerprints: [...new Set(group.map((intent) => intent.fingerprint))],
          },
        ];
  });

  return {
    callsPerRecipient: countBy(calls.map((call) => call.to)),
    intentsPerRecipient: countBy(intents.map((intent) => intent.to)),
    accidentalDuplicates,
  };
}

export interface LedgerSenderOptions {
  readonly ledger: SendLedger;
  readonly run: string;
  readonly policy: string;
  readonly message?: string;
  readonly id?: string;
  readonly gate?: (to: string) => Promise<void>;
  readonly outcome?: (message: Message, attempt: SendAttempt) => SendOutcome;
}

const ACCEPTED: SendOutcome = { outcome: 'accepted' };

export function ledgerIntegration(
  options: LedgerSenderOptions,
): IntegrationDescriptor<Readonly<Record<string, never>>> {
  return {
    kind: INTEGRATION_KIND,
    id: options.id ?? 'outlook',
    version: '1.0.0',
    configuration: { secrets: [{ name: 'TOKEN', required: true, sensitive: true }], validateSettings: () => valid({}) },
    roles: {
      sender: {
        contract: SENDER_CONTRACT,
        capabilities: {
          cc: true,
          replyTo: true,
          inlineAttachments: true,
          sentCopy: 'never',
          recipientAcceptance: 'transaction',
        },
        prepare: () =>
          Promise.resolve({
            send: async (message: Message, attempt: SendAttempt) => {
              const outcome = options.outcome?.(message, attempt) ?? ACCEPTED;

              options.ledger.record({
                run: options.run,
                policy: options.policy,
                message: options.message ?? LIST_MESSAGE,
                to: message.to,
                fingerprint: fingerprintOf(message),
                attemptId: attempt.attemptId,
                call: attempt.call,
                outcome: outcome.outcome,
              });
              await options.gate?.(message.to);

              return outcome;
            },
            close: () => Promise.resolve(),
          }),
      },
    },
  };
}

export async function preparedLedgerSender(options: LedgerSenderOptions): Promise<PreparedConnectionSender> {
  const checked = validateIntegrationDescriptor(ledgerIntegration(options));
  const from = parseEmailAddress('noreply@acme.test');

  if (!checked.ok || !from.ok) {
    throw new Error('test setup: the ledger sender is not valid');
  }

  const prepared = await checked.value.sender.prepare({
    connectionId: 'outlook-1',
    from: from.value,
    stateKey: 'ledger',
    settings: {},
    secrets: { TOKEN: 'not-a-secret' },
    stateDirectory: '',
    interaction: { announce: () => undefined },
    interactive: false,
    signal: new AbortController().signal,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  if (!prepared.ok) {
    throw new Error(prepared.reasons.join('; '));
  }

  return { capabilities: checked.value.sender.capabilities, sender: prepared.value };
}
