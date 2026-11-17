import { INTEGRATION_KIND, type SecretDeclaration } from './integration-descriptor';
import {
  type RecipientAcceptance,
  SENDER_CONTRACT,
  type SendAttempt,
  type SendPreferences,
  type SenderCapabilities,
  type SenderContext,
  type SentCopy,
} from './sender';
import { type ValidatedSendOutcome, settleSend } from './validate-send-outcome';
import { clipUntrustedText, describeThrown, readFields, readItems, readOwnKeys } from '../domain/kernel/read-untrusted';
import { type ValidationOutcome, invalid, valid } from '../domain/kernel/validation-outcome';
import type { Message } from '../domain/messaging/message';

declare const validatedIntegration: unique symbol;

export interface ValidatedPreparedSender {
  send(message: Message, attempt: SendAttempt, preferences: SendPreferences): Promise<ValidatedSendOutcome>;
  close(): Promise<void>;
}

export interface ValidatedSenderRole {
  readonly capabilities: SenderCapabilities;
  prepare(context: SenderContext<unknown>): Promise<ValidationOutcome<ValidatedPreparedSender>>;
}

export interface ValidatedConfiguration {
  readonly secrets: readonly SecretDeclaration[];
  validateSettings(raw: unknown): ValidationOutcome<unknown>;
}

export interface ValidatedIntegration {
  readonly [validatedIntegration]: true;
  readonly id: string;
  readonly version: string;
  readonly displayName?: string;
  readonly documentationUrl?: string;
  readonly configuration: ValidatedConfiguration;
  readonly sender: ValidatedSenderRole;
  readonly ignoredRoles: readonly string[];
}

const ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const MAX_ID_LENGTH = 214;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_SECRETS = 50;
const MAX_SETTINGS_REASONS = 50;
const SENDER_CONTRACT_PATTERN = /^sender\/(?:0|[1-9]\d*)$/;
const WEB_URL = /^https?:\/\/\S+$/i;
const SENT_COPY: readonly SentCopy[] = ['never', 'optional', 'always'];
const RECIPIENT_ACCEPTANCE: readonly RecipientAcceptance[] = ['per-recipient', 'transaction'];

export function validateIntegrationDescriptor(raw: unknown): ValidationOutcome<ValidatedIntegration> {
  const read = readFields(raw, ['kind', 'id', 'version', 'displayName', 'documentationUrl', 'configuration', 'roles']);

  if (!read.ok) {
    return invalid([`the integration descriptor ${read.error}`]);
  }

  const { kind, configuration, roles } = read.fields;
  const reasons: string[] = [];

  if (kind !== INTEGRATION_KIND) {
    reasons.push(`"kind" must be "${INTEGRATION_KIND}"`);
  }

  const id = typeof read.fields['id'] === 'string' ? read.fields['id'] : undefined;
  const validId = id !== undefined && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id) ? id : undefined;

  if (validId === undefined) {
    reasons.push('"id" must be a package-style name such as "acme-mail" or "@acme/mail"');
  }

  const version = textOrUndefined(read.fields['version']);

  if (version === undefined) {
    reasons.push('"version" must be non-empty text');
  }

  const displayName = optionalText(
    read.fields['displayName'],
    '"displayName" must be non-empty text when present',
    reasons,
  );
  const documentationUrl = optionalText(
    read.fields['documentationUrl'],
    '"documentationUrl" must be an http:// or https:// address when present',
    reasons,
    WEB_URL,
  );
  const config = checkConfiguration(configuration, reasons);
  const roleCheck = checkRoles(roles, reasons);

  if (
    reasons.length > 0 ||
    validId === undefined ||
    version === undefined ||
    displayName === null ||
    documentationUrl === null ||
    config === undefined ||
    roleCheck === undefined
  ) {
    return invalid(reasons);
  }

  const integration: Omit<ValidatedIntegration, typeof validatedIntegration> = {
    id: validId,
    version,
    ...(displayName === undefined ? {} : { displayName }),
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
    configuration: config,
    sender: roleCheck.sender,
    ignoredRoles: Object.freeze([...roleCheck.ignoredRoles]),
  };

  return valid(Object.freeze(integration) as ValidatedIntegration);
}

export function ensureUniqueIntegrationIds(
  integrations: readonly ValidatedIntegration[],
): ValidationOutcome<readonly ValidatedIntegration[]> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  for (const integration of integrations) {
    if (seen.has(integration.id)) {
      duplicated.add(integration.id);
    }

    seen.add(integration.id);
  }

  return duplicated.size === 0
    ? valid(integrations)
    : invalid([...duplicated].map((id) => `two active integrations share the id "${id}"; remove one of them`));
}

function checkConfiguration(raw: unknown, reasons: string[]): ValidatedConfiguration | undefined {
  const read = readFields(raw, ['secrets', 'validateSettings']);

  if (!read.ok) {
    reasons.push(`"configuration" ${read.error}`);

    return undefined;
  }

  const { secrets, validateSettings } = read.fields;
  const declared = checkSecrets(secrets, reasons);

  if (typeof validateSettings !== 'function') {
    reasons.push('"configuration.validateSettings" must be a function');

    return undefined;
  }

  if (declared === undefined) {
    return undefined;
  }

  return Object.freeze({
    secrets: declared,
    validateSettings: (settings: unknown): ValidationOutcome<unknown> => {
      let result: unknown;

      try {
        result = Reflect.apply(validateSettings, raw, [settings]);
      } catch (error) {
        return invalid([`the integration's settings check failed: ${describeThrown(error)}`]);
      }

      return checkValidationOutcome(result);
    },
  });
}

function checkValidationOutcome(raw: unknown): ValidationOutcome<unknown> {
  const read = readFields(raw, ['ok', 'value', 'reasons']);
  const notAnOutcome = invalid<unknown>([
    "the integration's settings check did not return a validation outcome ({ ok: true, value } or { ok: false, reasons })",
  ]);

  if (!read.ok) {
    return notAnOutcome;
  }

  const { ok, value, reasons } = read.fields;

  if (ok === true) {
    return valid(value);
  }

  if (ok !== false) {
    return notAnOutcome;
  }

  const list = readItems(reasons, MAX_SETTINGS_REASONS);
  const texts = list.ok ? list.items.filter((item): item is string => typeof item === 'string') : [];

  return list.ok && texts.length === list.items.length && texts.length > 0
    ? invalid(texts.map(clipUntrustedText))
    : notAnOutcome;
}

function checkSecrets(raw: unknown, reasons: string[]): readonly SecretDeclaration[] | undefined {
  const list = readItems(raw, MAX_SECRETS);

  if (!list.ok) {
    reasons.push(`"configuration.secrets" ${list.error}`);

    return undefined;
  }

  const declared: SecretDeclaration[] = [];
  const names = new Set<string>();
  const before = reasons.length;

  list.items.forEach((item, index) => {
    const read = readFields(item, ['name', 'required', 'sensitive']);
    const at = `"configuration.secrets[${String(index)}]"`;

    if (!read.ok) {
      reasons.push(`${at} ${read.error}`);

      return;
    }

    const { required, sensitive } = read.fields;
    const name =
      typeof read.fields['name'] === 'string' && SECRET_NAME.test(read.fields['name'])
        ? read.fields['name']
        : undefined;

    if (name === undefined) {
      reasons.push(`${at}.name must be upper-case letters, digits and "_", starting with a letter`);
    } else if (names.has(name)) {
      reasons.push(`${at}.name "${name}" is declared twice`);
    } else {
      names.add(name);
    }

    if (typeof required !== 'boolean' || typeof sensitive !== 'boolean') {
      reasons.push(`${at} must say whether it is required and sensitive (true or false)`);
    } else if (name !== undefined) {
      declared.push(Object.freeze({ name, required, sensitive }));
    }
  });

  return reasons.length === before ? Object.freeze(declared) : undefined;
}

interface RoleCheck {
  readonly sender: ValidatedSenderRole;
  readonly ignoredRoles: readonly string[];
}

function checkRoles(raw: unknown, reasons: string[]): RoleCheck | undefined {
  const read = readFields(raw, ['sender']);
  const keys = readOwnKeys(raw);

  if (!read.ok || !keys.ok) {
    reasons.push(`"roles" ${!read.ok ? read.error : keys.ok ? '' : keys.error}`);

    return undefined;
  }

  const ignoredRoles = keys.keys.filter((key) => key !== 'sender').map(clipUntrustedText);

  if (read.fields['sender'] === undefined) {
    reasons.push(
      ignoredRoles.length > 0
        ? `none of its roles (${ignoredRoles.join(', ')}) is supported by this mailroll, which supports: sender`
        : '"roles" declares no role; this mailroll supports: sender',
    );

    return undefined;
  }

  const sender = checkSender(read.fields['sender'], reasons);

  return sender === undefined ? undefined : { sender, ignoredRoles };
}

function checkSender(raw: unknown, reasons: string[]): ValidatedSenderRole | undefined {
  const read = readFields(raw, ['contract', 'capabilities', 'prepare']);

  if (!read.ok) {
    reasons.push(`"roles.sender" ${read.error}`);

    return undefined;
  }

  const { contract, capabilities, prepare } = read.fields;
  const before = reasons.length;

  if (contract !== SENDER_CONTRACT) {
    reasons.push(
      typeof contract === 'string' && SENDER_CONTRACT_PATTERN.test(contract)
        ? `"roles.sender" requires the "${contract}" contract; this mailroll supports "${SENDER_CONTRACT}"`
        : `"roles.sender.contract" must name a sender contract such as "${SENDER_CONTRACT}"`,
    );
  }

  if (typeof prepare !== 'function') {
    reasons.push('"roles.sender.prepare" must be a function');
  }

  const checked = checkCapabilities(capabilities, reasons);

  if (reasons.length > before || checked === undefined || typeof prepare !== 'function') {
    return undefined;
  }

  return Object.freeze({
    capabilities: checked,
    prepare: async (context: SenderContext<unknown>): Promise<ValidationOutcome<ValidatedPreparedSender>> => {
      const prepared: unknown = await Promise.resolve().then((): unknown => Reflect.apply(prepare, raw, [context]));

      return checkPreparedSender(prepared, checked);
    },
  });
}

function checkPreparedSender(
  raw: unknown,
  capabilities: SenderCapabilities,
): ValidationOutcome<ValidatedPreparedSender> {
  const read = readFields(raw, ['send', 'close']);

  if (!read.ok) {
    return invalid([`"roles.sender.prepare" resolved to something that ${read.error}`]);
  }

  const { send, close } = read.fields;
  const reasons: string[] = [];

  if (typeof send !== 'function') {
    reasons.push('the prepared sender\'s "send" must be a function');
  }

  if (typeof close !== 'function') {
    reasons.push('the prepared sender\'s "close" must be a function');
  }

  if (typeof send !== 'function' || typeof close !== 'function') {
    return invalid(reasons);
  }

  return valid(
    Object.freeze({
      send: (message: Message, attempt: SendAttempt, preferences: SendPreferences): Promise<ValidatedSendOutcome> =>
        settleSend((): unknown => Reflect.apply(send, raw, [message, attempt, preferences]), { capabilities, message }),
      close: async (): Promise<void> => {
        await Promise.resolve().then((): unknown => Reflect.apply(close, raw, []));
      },
    }),
  );
}

export function validateSenderCapabilities(raw: unknown): ValidationOutcome<SenderCapabilities> {
  const reasons: string[] = [];
  const capabilities = checkCapabilities(raw, reasons);

  return capabilities === undefined ? invalid(reasons) : valid(capabilities);
}

function checkCapabilities(raw: unknown, reasons: string[]): SenderCapabilities | undefined {
  const read = readFields(raw, [
    'cc',
    'replyTo',
    'inlineAttachments',
    'maxMessageBytes',
    'maxCc',
    'sentCopy',
    'recipientAcceptance',
  ]);

  if (!read.ok) {
    reasons.push(`"roles.sender.capabilities" ${read.error}`);

    return undefined;
  }

  const fields = read.fields;
  const at = '"roles.sender.capabilities';
  const cc = booleanField(fields['cc'], `${at}.cc"`, reasons);
  const replyTo = booleanField(fields['replyTo'], `${at}.replyTo"`, reasons);
  const inlineAttachments = booleanField(fields['inlineAttachments'], `${at}.inlineAttachments"`, reasons);
  const maxMessageBytes = optionalPositiveInteger(fields['maxMessageBytes'], `${at}.maxMessageBytes"`, reasons);
  const maxCc = optionalPositiveInteger(fields['maxCc'], `${at}.maxCc"`, reasons);
  const sentCopy = SENT_COPY.find((value) => value === fields['sentCopy']);
  const recipientAcceptance = RECIPIENT_ACCEPTANCE.find((value) => value === fields['recipientAcceptance']);

  if (maxCc !== undefined && cc !== true) {
    reasons.push(`${at}.maxCc" only makes sense when "cc" is true`);
  }

  if (sentCopy === undefined) {
    reasons.push(`${at}.sentCopy" must be one of: ${SENT_COPY.join(', ')}`);
  }

  if (recipientAcceptance === undefined) {
    reasons.push(`${at}.recipientAcceptance" must be one of: ${RECIPIENT_ACCEPTANCE.join(', ')}`);
  }

  if (
    cc === undefined ||
    replyTo === undefined ||
    inlineAttachments === undefined ||
    maxMessageBytes === null ||
    maxCc === null ||
    (maxCc !== undefined && !cc) ||
    sentCopy === undefined ||
    recipientAcceptance === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    cc,
    replyTo,
    inlineAttachments,
    ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    ...(maxCc === undefined ? {} : { maxCc }),
    sentCopy,
    recipientAcceptance,
  });
}

function booleanField(value: unknown, label: string, reasons: string[]): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  reasons.push(`${label} must be true or false`);

  return undefined;
}

function optionalPositiveInteger(value: unknown, label: string, reasons: string[]): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  reasons.push(`${label} must be a positive whole number when present`);

  return null;
}

function optionalText(value: unknown, message: string, reasons: string[], pattern?: RegExp): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  const text = textOrUndefined(value);

  if (text !== undefined && (pattern === undefined || pattern.test(text))) {
    return text;
  }

  reasons.push(message);

  return null;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
