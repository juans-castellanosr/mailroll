import { describe, expect, it } from 'vitest';
import { AuthError, DataSourceError, SignInRequiredError } from '@mailroll/core';
import type { FetchFn } from '../src/graph-client';
import { SentItemsReader } from '../src/sent-items-reader';

const BASE = 'https://graph.test/sentitems';
const SINCE = new Date('2026-09-01T00:00:00Z');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function item(subject: string | null, to: string, cc: readonly string[], sent: string): unknown {
  return {
    subject,
    sentDateTime: sent,
    toRecipients: [{ emailAddress: { address: to, name: 'X' } }],
    ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
  };
}

function href(input: Parameters<FetchFn>[0]): string {
  if (typeof input === 'string') {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

function reader(fetchFn: FetchFn, token: () => Promise<string> = () => Promise.resolve('TOKEN')) {
  return new SentItemsReader({ getAccessToken: token, fetchFn, baseUrl: BASE });
}

describe('SentItemsReader.listSince', () => {
  it('requests Sent Items since the date with a bearer token and maps the fields', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push({ url: href(url), init });

      return Promise.resolve(
        json({ value: [item('Asunto', 'a@x.co', ['c1@x.co', 'c2@x.co'], '2026-09-14T17:01:49Z')] }),
      );
    };

    const messages = await reader(fetchFn).listSince(SINCE);

    expect(messages).toEqual([
      { subject: 'Asunto', to: ['a@x.co'], cc: ['c1@x.co', 'c2@x.co'], sentAt: '2026-09-14T17:01:49Z' },
    ]);

    const first = calls[0];

    expect(first?.init?.method).toBe('GET');
    expect(new Headers(first?.init?.headers).get('Authorization')).toBe('Bearer TOKEN');

    const query = new URL(first?.url ?? '').searchParams;

    expect(query.get('$filter')).toBe('sentDateTime ge 2026-09-01T00:00:00.000Z');
    expect(query.get('$select')).toBe('subject,toRecipients,ccRecipients,sentDateTime');
  });

  it('follows @odata.nextLink until the last page', async () => {
    const next = `${BASE}?page=2`;
    const fetchFn: FetchFn = (url) =>
      Promise.resolve(
        href(url) === next
          ? json({ value: [item('B', 'b@x.co', [], '2026-09-02T00:00:00Z')] })
          : json({ value: [item('A', 'a@x.co', [], '2026-09-01T00:00:00Z')], '@odata.nextLink': next }),
      );

    const messages = await reader(fetchFn).listSince(SINCE);

    expect(messages.map((m) => m.subject)).toEqual(['A', 'B']);
  });

  it('maps a null subject to an empty string and missing CC to an empty list', async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(json({ value: [{ subject: null, sentDateTime: '2026-09-03T00:00:00Z' }] }));

    const [message] = await reader(fetchFn).listSince(SINCE);

    expect(message).toEqual({ subject: '', to: [], cc: [], sentAt: '2026-09-03T00:00:00Z' });
  });

  it('raises AuthError when Graph refuses access (missing Mail.Read)', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response('denied', { status: 403 }));

    await expect(reader(fetchFn).listSince(SINCE)).rejects.toThrow(AuthError);
  });

  it('raises AuthError when no token can be obtained', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(json({ value: [] }));
    const failing = (): Promise<string> => Promise.reject(new Error('no account'));

    await expect(reader(fetchFn, failing).listSince(SINCE)).rejects.toThrow(AuthError);
  });

  it('raises DataSourceError on a server error', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response('boom', { status: 500 }));

    await expect(reader(fetchFn).listSince(SINCE)).rejects.toThrow(DataSourceError);
  });

  it('raises DataSourceError on an unexpected response shape', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(json({ items: [] }));

    await expect(reader(fetchFn).listSince(SINCE)).rejects.toThrow(DataSourceError);
  });

  it('never sends the token to a nextLink outside the Graph origin', async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url) => {
      seen.push(href(url));

      return Promise.resolve(json({ value: [], '@odata.nextLink': 'https://collector.attacker.example/steal' }));
    };

    await expect(reader(fetchFn).listSince(SINCE)).rejects.toThrow(DataSourceError);
    expect(seen.every((u) => u.startsWith('https://graph.test/'))).toBe(true);
  });

  it('waits as Microsoft asks on HTTP 429 and then continues', async () => {
    const waits: number[] = [];
    const responses = [
      new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      json({ value: [item('Hi', 'a@x.co', [], '2026-09-14T17:01:49Z')] }),
    ];
    const fetchFn: FetchFn = () => Promise.resolve(responses.shift() ?? json({ value: [] }));
    const throttled = new SentItemsReader({
      getAccessToken: () => Promise.resolve('TOKEN'),
      fetchFn,
      baseUrl: BASE,
      sleep: (ms) => {
        waits.push(ms);

        return Promise.resolve();
      },
    });

    const messages = await throttled.listSince(SINCE);

    expect(waits).toEqual([7000]);
    expect(messages.map((m) => m.subject)).toEqual(['Hi']);
  });

  it('gives up after repeated HTTP 429 answers', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response('slow down', { status: 429 }));
    const throttled = new SentItemsReader({
      getAccessToken: () => Promise.resolve('TOKEN'),
      fetchFn,
      baseUrl: BASE,
      sleep: () => Promise.resolve(),
    });

    await expect(throttled.listSince(SINCE)).rejects.toThrow(/HTTP 429/);
  });

  it('asks for a token on every page, so a long export survives a token refresh', async () => {
    let tokens = 0;
    const pages = [json({ value: [], '@odata.nextLink': `${BASE}?page=2` }), json({ value: [] })];
    const fetchFn: FetchFn = () => Promise.resolve(pages.shift() ?? json({ value: [] }));

    await reader(fetchFn, () => {
      tokens += 1;

      return Promise.resolve(`TOKEN-${String(tokens)}`);
    }).listSince(SINCE);

    expect(tokens).toBe(2);
  });

  it('reports a page that is not JSON as a data source error', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(new Response('<html>', { status: 200 }));

    await expect(reader(fetchFn).listSince(SINCE)).rejects.toThrow(DataSourceError);
  });

  it('keeps the type of an authentication error, so callers can tell a missing sign-in apart', async () => {
    const fetchFn: FetchFn = () => Promise.resolve(json({ value: [] }));
    const missing = new SignInRequiredError('no saved sign-in');

    await expect(reader(fetchFn, () => Promise.reject(missing)).listSince(SINCE)).rejects.toBe(missing);
  });
});
