import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AuthError, DataSourceError } from '@mailroll/core';
import type { FetchFn } from './graph-client';

export interface SentMessage {
  readonly subject: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly sentAt: string;
}

export interface SentItemsReaderOptions {
  readonly getAccessToken: () => Promise<string>;
  readonly fetchFn?: FetchFn;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages';
const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_THROTTLE_RETRIES = 5;
const MAX_THROTTLE_WAIT_MS = 60_000;

const MAX_ERROR_DETAIL_LENGTH = 300;

const recipientSchema = z.object({
  emailAddress: z.looseObject({ address: z.string() }),
});
const messageSchema = z.looseObject({
  subject: z.string().nullable(),
  sentDateTime: z.string(),
  toRecipients: z.array(recipientSchema).default([]),
  ccRecipients: z.array(recipientSchema).default([]),
});
const pageSchema = z.looseObject({
  value: z.array(messageSchema),
  '@odata.nextLink': z.url().optional(),
});

export class SentItemsReader {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SentItemsReaderOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
  }

  async listSince(since: Date): Promise<SentMessage[]> {
    const messages: SentMessage[] = [];
    const origin = new URL(this.baseUrl).origin;
    let url: string | undefined = this.firstPageUrl(since);

    for (let pages = 0; url !== undefined; pages += 1) {
      if (pages >= MAX_PAGES) {
        throw new DataSourceError(`Sent Items export stopped after ${String(MAX_PAGES)} pages`);
      }

      if (new URL(url).origin !== origin) {
        throw new DataSourceError(`refusing to follow a nextLink outside ${origin}`);
      }

      const page = await this.fetchPage(url);

      for (const item of page.value) {
        messages.push({
          subject: item.subject ?? '',
          to: item.toRecipients.map((r) => r.emailAddress.address),
          cc: item.ccRecipients.map((r) => r.emailAddress.address),
          sentAt: item.sentDateTime,
        });
      }

      url = page['@odata.nextLink'];
    }

    return messages;
  }

  private firstPageUrl(since: Date): string {
    const params = new URLSearchParams({
      $select: 'subject,toRecipients,ccRecipients,sentDateTime',
      $filter: `sentDateTime ge ${since.toISOString()}`,
      $orderby: 'sentDateTime asc',
      $top: String(PAGE_SIZE),
    });

    return `${this.baseUrl}?${params.toString()}`;
  }

  private async fetchPage(url: string): Promise<z.infer<typeof pageSchema>> {
    for (let throttles = 0; ; throttles += 1) {
      const response = await this.request(url, await this.token());

      if (response.status === 429 && throttles < MAX_THROTTLE_RETRIES) {
        await this.sleep(retryAfterMs(response.headers.get('retry-after'), throttles));
        continue;
      }

      return this.readPage(response);
    }
  }

  private async token(): Promise<string> {
    try {
      return await this.getAccessToken();
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      const detail = error instanceof Error ? error.message : 'unknown error';

      throw new AuthError(`authentication failed: ${detail}`, { cause: error });
    }
  }

  private async request(url: string, token: string): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new DataSourceError('network error contacting Microsoft Graph', { cause: error });
    }
  }

  private async readPage(response: Response): Promise<z.infer<typeof pageSchema>> {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Microsoft Graph refused Sent Items access (HTTP ${String(response.status)}) — is Mail.ReadBasic granted?`,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      const detail = (await response.text().catch(() => ''))
        .slice(0, MAX_ERROR_DETAIL_LENGTH)
        .replace(/\s+/g, ' ')
        .trim();

      throw new DataSourceError(
        `Microsoft Graph Sent Items read failed (HTTP ${String(response.status)})${detail.length > 0 ? `: ${detail}` : ''}`,
      );
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch (error) {
      throw new DataSourceError('Microsoft Graph returned a Sent Items page that is not valid JSON', { cause: error });
    }

    const parsed = pageSchema.safeParse(body);

    if (!parsed.success) {
      throw new DataSourceError('unexpected Sent Items response shape from Microsoft Graph');
    }

    return parsed.data;
  }
}

function retryAfterMs(header: string | null, attempt: number): number {
  const seconds = header === null ? Number.NaN : Number(header);
  const hinted = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;

  return Math.min(hinted, MAX_THROTTLE_WAIT_MS);
}
