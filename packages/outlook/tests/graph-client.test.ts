import { describe, expect, it } from 'vitest';
import { type EmailAddress, type Message, parseEmailAddress, SendError } from '@mailroll/core';
import { type FetchFn, GraphClient, type GraphClientOptions } from '../src/graph-client';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

const MESSAGE: Message = {
  to: addr('teacher@university.example'),
  subject: 'Acceso',
  html: '<p>hola</p>',
  inlineAttachments: [{ cid: 'brand-logo', filename: 'logo.png', contentType: 'image/png', contentBase64: 'AAAA' }],
};

interface ParsedBody {
  message: {
    subject: string;
    body: { contentType: string; content: string };
    toRecipients: { emailAddress: { address: string } }[];
    attachments?: { '@odata.type': string; isInline: boolean; contentId: string; contentBytes: string }[];
  };
  saveToSentItems: boolean;
}

function client(fetchFn: FetchFn, overrides: Partial<GraphClientOptions> = {}): GraphClient {
  return new GraphClient({
    getAccessToken: () => Promise.resolve('TOKEN'),
    saveToSentItems: false,
    fetchFn,
    ...overrides,
  });
}

const respondWith =
  (status: number, body = '', headers: Record<string, string> = {}): FetchFn =>
  () =>
    Promise.resolve(new Response(body, { status, headers }));

function readBody(init: RequestInit | undefined): ParsedBody {
  const body = init?.body;

  if (typeof body !== 'string') {
    throw new Error('expected a string body');
  }

  return JSON.parse(body) as ParsedBody;
}

describe('GraphClient.sendMail', () => {
  it('POSTs a well-formed request and resolves on 202', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: FetchFn = (_url, init) => {
      capturedInit = init;

      return Promise.resolve(new Response(null, { status: 202 }));
    };

    await client(fetchFn).sendMail(MESSAGE);

    const body = readBody(capturedInit);

    expect(body.saveToSentItems).toBe(false);
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>hola</p>' });
    expect(body.message.toRecipients[0]?.emailAddress.address).toBe('teacher@university.example');
    expect(body.message.attachments?.[0]).toMatchObject({ isInline: true, contentId: 'brand-logo' });
  });

  it('maps 429 with Retry-After to throttled with delay', async () => {
    const error = await client(respondWith(429, 'throttled', { 'Retry-After': '5' }))
      .sendMail(MESSAGE)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SendError);
    expect(error).toMatchObject({ category: 'throttled', retryAfterMs: 5000 });
  });

  it('maps a token-acquisition failure to an auth SendError', async () => {
    const graph = new GraphClient({
      getAccessToken: () => Promise.reject(new Error('declined')),
      saveToSentItems: false,
      fetchFn: respondWith(202),
    });
    const error = await graph.sendMail(MESSAGE).catch((e: unknown) => e);

    expect((error as SendError).category).toBe('auth');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [503, 'uncertain'],
    [500, 'uncertain'],
    [502, 'uncertain'],
    [504, 'uncertain'],
    [408, 'uncertain'],
    [520, 'uncertain'],
    [400, 'permanent'],
  ])('maps HTTP %i to a %s SendError', async (status, category) => {
    const error = await client(respondWith(status, '{"error":{}}'))
      .sendMail(MESSAGE)
      .catch((e: unknown) => e);

    expect((error as SendError).category).toBe(category);
  });

  it('treats a 503 as throttling only when Graph says how long to wait', async () => {
    const error = await client(respondWith(503, 'busy', { 'Retry-After': '30' }))
      .sendMail(MESSAGE)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ category: 'throttled', retryAfterMs: 30_000 });
  });

  it('retries only failures that certainly happened before the request was sent', async () => {
    const withCode = (code: string): Error =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    const refused = await client(() => Promise.reject(withCode('ECONNREFUSED')))
      .sendMail(MESSAGE)
      .catch((e: unknown) => e);

    expect((refused as SendError).category).toBe('transient');

    const reset = await client(() => Promise.reject(withCode('ECONNRESET')))
      .sendMail(MESSAGE)
      .catch((e: unknown) => e);

    expect((reset as SendError).category).toBe('uncertain');
  });

  it('gives every request a deadline and records a timeout as uncertain', async () => {
    const graph = new GraphClient({
      getAccessToken: () => Promise.resolve('t'),
      saveToSentItems: false,
      requestTimeoutMs: 20,
      fetchFn: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason: unknown = init.signal?.reason;

            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    });
    const error = await graph.sendMail(MESSAGE).catch((e: unknown) => e);

    expect(error).toMatchObject({ category: 'uncertain' });
    expect((error as SendError).message).toMatch(/may or may not have been sent/);
  });
});
