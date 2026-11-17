const SEND_ERROR_CATEGORIES = ['transient', 'permanent', 'auth', 'throttled', 'uncertain'] as const;

export type SendErrorCategory = (typeof SEND_ERROR_CATEGORIES)[number];

export type FailureCategory = Exclude<SendErrorCategory, 'uncertain'>;

interface ErrorCause {
  readonly cause?: unknown;
}

export abstract class MailrollError extends Error {
  constructor(message: string, options?: ErrorCause) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends MailrollError {}

export class DataSourceError extends MailrollError {}

export class TemplateRenderError extends MailrollError {}

export class AuthError extends MailrollError {}

export class SignInRequiredError extends AuthError {}

interface SendErrorOptions extends ErrorCause {
  readonly retryAfterMs?: number;
}

export class SendError extends MailrollError {
  readonly category: SendErrorCategory;
  readonly retryAfterMs?: number;

  constructor(message: string, category: SendErrorCategory, options?: SendErrorOptions) {
    super(message, options);
    this.category = category;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export interface RecognizedSendError {
  readonly category: SendErrorCategory;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export function recognizeSendError(error: unknown): RecognizedSendError | undefined {
  if (!(error instanceof Error) || error.name !== 'SendError' || !('category' in error)) {
    return undefined;
  }

  const { category } = error;

  if (!isSendErrorCategory(category)) {
    return undefined;
  }

  const retryAfterMs = 'retryAfterMs' in error ? error.retryAfterMs : undefined;

  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? { category, message: error.message, retryAfterMs }
    : { category, message: error.message };
}

export function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isSendErrorCategory(value: unknown): value is SendErrorCategory {
  return SEND_ERROR_CATEGORIES.some((category) => category === value);
}

export class StatePersistenceError extends MailrollError {
  constructor(
    message: string,
    readonly recipient: string | undefined,
    options?: ErrorCause,
  ) {
    super(message, options);
  }
}

export class RunCancelledError extends MailrollError {}

export class SendCancelledError extends MailrollError {}
