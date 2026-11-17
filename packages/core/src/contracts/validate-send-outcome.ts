import type { FailureScope, NotAcceptedReason, SenderCapabilities } from './sender';
import { type EmailAddress, normalizeEmail, parseEmailAddress } from '../domain/addressing/email-address';
import { describeThrown, readFields, readItems } from '../domain/kernel/read-untrusted';
import type { Message } from '../domain/messaging/message';

declare const validatedOutcome: unique symbol;

interface ValidatedBrand {
  readonly [validatedOutcome]: true;
}

export interface SendExpectation {
  readonly capabilities: SenderCapabilities;
  readonly message: Message;
}

export interface ValidatedAcceptedOutcome extends ValidatedBrand {
  readonly outcome: 'accepted';
  readonly providerMessageId?: string;
  readonly ccRejected?: readonly EmailAddress[];
}

export interface ValidatedNotAcceptedOutcome extends ValidatedBrand {
  readonly outcome: 'not-accepted';
  readonly reason: NotAcceptedReason;
  readonly scope: FailureScope;
  readonly retryAfterMs?: number;
  readonly detail: string;
}

export interface ValidatedUnknownOutcome extends ValidatedBrand {
  readonly outcome: 'unknown';
  readonly detail: string;
  readonly violation?: string;
}

export type ValidatedSendOutcome = ValidatedAcceptedOutcome | ValidatedNotAcceptedOutcome | ValidatedUnknownOutcome;

type Unbranded<T> = T extends ValidatedBrand ? Omit<T, typeof validatedOutcome> : never;

const REASONS: readonly NotAcceptedReason[] = ['transient', 'throttled', 'auth', 'permanent'];
const SCOPES: readonly FailureScope[] = ['message', 'connection'];
const UNDESCRIBED = 'the integration could not tell whether the provider accepted the message';

export function validateSendOutcome(raw: unknown, expectation: SendExpectation): ValidatedSendOutcome {
  const read = readFields(raw, [
    'outcome',
    'providerMessageId',
    'ccRejected',
    'reason',
    'scope',
    'retryAfterMs',
    'detail',
  ]);

  if (!read.ok) {
    return violated(`the send result ${read.error}`);
  }

  const { outcome, providerMessageId, ccRejected, reason, scope, retryAfterMs, detail } = read.fields;

  switch (outcome) {
    case 'accepted':
      return acceptedOutcome(providerMessageId, ccRejected, expectation);
    case 'not-accepted':
      return notAcceptedOutcome(reason, scope, retryAfterMs, detail);
    case 'unknown':
      return isText(detail)
        ? brand({ outcome: 'unknown', detail })
        : brand({ outcome: 'unknown', detail: UNDESCRIBED, violation: '"detail" must be non-empty text' });
    default:
      return violated('"outcome" must be "accepted", "not-accepted" or "unknown"');
  }
}

export async function settleSend(invoke: () => unknown, expectation: SendExpectation): Promise<ValidatedSendOutcome> {
  let raw: unknown;

  try {
    raw = await invoke();
  } catch (error) {
    return brand({
      outcome: 'unknown',
      detail: `the send failed with an error, so the message may or may not have been sent: ${describeThrown(error)}`,
    });
  }

  return validateSendOutcome(raw, expectation);
}

function acceptedOutcome(
  providerMessageId: unknown,
  ccRejected: unknown,
  expectation: SendExpectation,
): ValidatedSendOutcome {
  if (providerMessageId !== undefined && !isText(providerMessageId)) {
    return violated('"providerMessageId" must be non-empty text when present');
  }

  const cc = expectation.message.cc ?? [];
  const observable = expectation.capabilities.recipientAcceptance === 'per-recipient' && cc.length > 0;
  const withId = providerMessageId === undefined ? {} : { providerMessageId };

  if (!observable) {
    return ccRejected === undefined
      ? brand({ outcome: 'accepted', ...withId })
      : violated(
          cc.length === 0
            ? '"ccRejected" must be absent when the message has no CC'
            : '"ccRejected" must be absent when the sender only observes whole transactions',
        );
  }

  const rejected = matchRejectedCc(ccRejected, cc);

  return typeof rejected === 'string'
    ? violated(rejected)
    : brand({ outcome: 'accepted', ...withId, ccRejected: rejected });
}

function matchRejectedCc(raw: unknown, cc: readonly EmailAddress[]): readonly EmailAddress[] | string {
  if (raw === undefined) {
    return '"ccRejected" is required when the sender observes each recipient and the message has a CC';
  }

  const list = readItems(raw, cc.length);

  if (!list.ok) {
    return `"ccRejected" ${list.error}`;
  }

  const byKey = new Map(cc.map((address) => [normalizeEmail(address), address]));
  const matched = new Map<string, EmailAddress>();

  for (const item of list.items) {
    const parsed = parseEmailAddress(item);
    const key = parsed.ok ? normalizeEmail(parsed.value) : undefined;
    const address = key === undefined ? undefined : byKey.get(key);

    if (key === undefined || address === undefined) {
      return '"ccRejected" lists an address that is not one of the message\'s CC';
    }

    if (matched.has(key)) {
      return '"ccRejected" lists the same CC twice';
    }

    matched.set(key, address);
  }

  return Object.freeze([...matched.values()]);
}

function notAcceptedOutcome(
  reason: unknown,
  scope: unknown,
  retryAfterMs: unknown,
  detail: unknown,
): ValidatedSendOutcome {
  const knownReason = REASONS.find((value) => value === reason);
  const knownScope = SCOPES.find((value) => value === scope);

  if (knownReason === undefined) {
    return violated(`"reason" must be one of: ${REASONS.join(', ')}`);
  }

  if (knownScope === undefined) {
    return violated(`"scope" must be one of: ${SCOPES.join(', ')}`);
  }

  if (knownReason === 'auth' && knownScope !== 'connection') {
    return violated('an "auth" rejection always affects the whole connection ("scope": "connection")');
  }

  if (
    retryAfterMs !== undefined &&
    (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)
  ) {
    return violated('"retryAfterMs" must be a finite number of milliseconds, zero or more, when present');
  }

  if (!isText(detail)) {
    return violated('"detail" must be non-empty text');
  }

  return brand({
    outcome: 'not-accepted',
    reason: knownReason,
    scope: knownScope,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    detail,
  });
}

function violated(violation: string): ValidatedSendOutcome {
  return brand({
    outcome: 'unknown',
    detail: `the integration returned a result that does not follow the sender contract, so the message may or may not have been sent: ${violation}`,
    violation,
  });
}

function brand(outcome: Unbranded<ValidatedSendOutcome>): ValidatedSendOutcome {
  return Object.freeze(outcome) as ValidatedSendOutcome;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
