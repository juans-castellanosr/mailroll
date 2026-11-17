import { type InlineAttachment, type Message, SendError, type SendOutcome } from '@mailroll/core';

export type FetchFn = typeof fetch;

export interface GraphSendOptions {
  readonly saveToSentItems: boolean;
}

export interface GraphClientOptions {
  readonly getAccessToken: () => Promise<string>;
  readonly saveToSentItems?: boolean;
  readonly fetchFn?: FetchFn;
  readonly sendMailUrl?: string;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_SEND_MAIL_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ERROR_DETAIL_LENGTH = 300;

const PRE_SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
]);

interface GraphRecipient {
  readonly emailAddress: { readonly address: string };
}

interface GraphAttachment {
  readonly '@odata.type': '#microsoft.graph.fileAttachment';
  readonly name: string;
  readonly contentType: string;
  readonly contentBytes: string;
  readonly isInline: boolean;
  readonly contentId: string;
}

interface GraphMessage {
  readonly subject: string;
  readonly body: { readonly contentType: 'HTML'; readonly content: string };
  readonly toRecipients: readonly GraphRecipient[];
  readonly ccRecipients?: readonly GraphRecipient[];
  readonly replyTo?: readonly GraphRecipient[];
  readonly attachments?: readonly GraphAttachment[];
}

interface GraphSendMailRequest {
  readonly message: GraphMessage;
  readonly saveToSentItems: boolean;
}

export class GraphClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly saveToSentItems: boolean;
  private readonly fetchFn: FetchFn;
  private readonly sendMailUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(options: GraphClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.saveToSentItems = options.saveToSentItems ?? false;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sendMailUrl = options.sendMailUrl ?? DEFAULT_SEND_MAIL_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async sendMail(message: Message): Promise<void> {
    await this.transmit(message, this.saveToSentItems);
  }

  async send(message: Message, options: GraphSendOptions): Promise<SendOutcome> {
    try {
      await this.transmit(message, options.saveToSentItems);
    } catch (error) {
      if (error instanceof SendError) {
        return outcomeOf(error);
      }

      throw error;
    }

    return { outcome: 'accepted' };
  }

  private async transmit(message: Message, saveToSentItems: boolean): Promise<void> {
    let token: string;

    try {
      token = await this.getAccessToken();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';

      throw new SendError(`authentication failed: ${detail}`, 'auth', { cause: error });
    }

    let response: Response;

    try {
      response = await this.fetchFn(this.sendMailUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildRequest(message, saveToSentItems)),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw classifyNetworkError(error, this.requestTimeoutMs);
    }

    if (response.status >= 200 && response.status < 300) {
      return;
    }

    throw await this.toSendError(response);
  }

  private buildRequest(message: Message, saveToSentItems: boolean): GraphSendMailRequest {
    const attachments = message.inlineAttachments?.map((a) => this.toGraphAttachment(a));
    const graphMessage: GraphMessage = {
      subject: message.subject,
      body: { contentType: 'HTML', content: message.html },
      toRecipients: [{ emailAddress: { address: message.to } }],
      ...(message.cc !== undefined && message.cc.length > 0
        ? { ccRecipients: message.cc.map((address) => ({ emailAddress: { address } })) }
        : {}),
      ...(message.replyTo !== undefined ? { replyTo: [{ emailAddress: { address: message.replyTo } }] } : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    };

    return { message: graphMessage, saveToSentItems };
  }

  private toGraphAttachment(attachment: InlineAttachment): GraphAttachment {
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.filename,
      contentType: attachment.contentType,
      contentBytes: attachment.contentBase64,
      isInline: true,
      contentId: attachment.cid,
    };
  }

  private async toSendError(response: Response): Promise<SendError> {
    const status = response.status;
    const detail = await this.readErrorDetail(response);
    const message = `Microsoft Graph sendMail failed (HTTP ${String(status)})${detail.length > 0 ? `: ${detail}` : ''}`;

    if (status === 401 || status === 403) {
      return new SendError(message, 'auth');
    }

    const retryAfterMs = this.parseRetryAfter(response);

    if (status === 429 || (status === 503 && retryAfterMs !== undefined)) {
      return new SendError(message, 'throttled', retryAfterMs !== undefined ? { retryAfterMs } : {});
    }

    if (status === 408 || (status >= 500 && status <= 599)) {
      return new SendError(message, 'uncertain');
    }

    return new SendError(message, 'permanent');
  }

  private async readErrorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();

      return text.slice(0, MAX_ERROR_DETAIL_LENGTH).replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  private parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after');

    if (header === null) {
      return undefined;
    }

    const seconds = Number(header);

    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.round(seconds * 1000));
    }

    const dateMs = Date.parse(header);

    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }

    return undefined;
  }
}

function outcomeOf(error: SendError): SendOutcome {
  switch (error.category) {
    case 'uncertain':
      return { outcome: 'unknown', detail: error.message };
    case 'auth':
      return { outcome: 'not-accepted', reason: 'auth', scope: 'connection', detail: error.message };
    case 'throttled':
    case 'transient':
    case 'permanent':
      return {
        outcome: 'not-accepted',
        reason: error.category,
        scope: 'message',
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        detail: error.message,
      };
  }
}

function classifyNetworkError(error: unknown, timeoutMs: number): SendError {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new SendError(
      `no answer from Microsoft Graph within ${String(Math.round(timeoutMs / 1000))} s; the message may or may not have been sent`,
      'uncertain',
      { cause: error },
    );
  }

  const code = errorCode(error);

  if (code !== undefined && PRE_SEND_ERROR_CODES.has(code)) {
    return new SendError(`could not reach Microsoft Graph (${code})`, 'transient', { cause: error });
  }

  return new SendError(
    `connection to Microsoft Graph failed${code !== undefined ? ` (${code})` : ''}; the message may or may not have been sent`,
    'uncertain',
    { cause: error },
  );
}

function errorCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }

    current = current.cause;
  }

  return undefined;
}
