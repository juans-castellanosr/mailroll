import { describe, expect, it } from 'vitest';
import { INTEGRATION_KIND } from '../../src/contracts/integration-descriptor';
import { SENDER_CONTRACT, type SenderContext } from '../../src/contracts/sender';
import {
  type ValidatedIntegration,
  ensureUniqueIntegrationIds,
  validateIntegrationDescriptor,
} from '../../src/contracts/validate-descriptor';
import { requireEmailAddress } from '../../src/domain/addressing/require-email-address';
import { invalid, valid } from '../../src/domain/kernel/validation-outcome';

function capabilities(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cc: true,
    replyTo: true,
    inlineAttachments: false,
    sentCopy: 'never',
    recipientAcceptance: 'per-recipient',
    ...overrides,
  };
}

function descriptor(
  overrides: Record<string, unknown> = {},
  sender: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: INTEGRATION_KIND,
    id: 'acme-mail',
    version: '1.2.3',
    configuration: {
      secrets: [{ name: 'API_KEY', required: true, sensitive: true }],
      validateSettings: (raw: unknown) => valid(raw),
    },
    roles: {
      sender: {
        contract: SENDER_CONTRACT,
        capabilities: capabilities(),
        prepare: () =>
          Promise.resolve({ send: () => Promise.resolve({ outcome: 'accepted' }), close: () => Promise.resolve() }),
        ...sender,
      },
    },
    ...overrides,
  };
}

const context: SenderContext<unknown> = {
  connectionId: 'acme-1',
  from: requireEmailAddress('noreply@acme.test', 'from'),
  stateKey: 'acme_1',
  settings: {},
  secrets: {},
  stateDirectory: '/tmp/unused',
  interaction: { announce: () => undefined },
  interactive: false,
  signal: new AbortController().signal,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
};

function reasonsOf(raw: unknown): readonly string[] {
  const outcome = validateIntegrationDescriptor(raw);

  return outcome.ok ? [] : outcome.reasons;
}

function accepted(raw: unknown): ValidatedIntegration {
  const outcome = validateIntegrationDescriptor(raw);

  if (!outcome.ok) {
    throw new Error(`expected a valid descriptor, got: ${outcome.reasons.join('; ')}`);
  }

  return outcome.value;
}

describe('validateIntegrationDescriptor', () => {
  it('accepts a complete sender integration and keeps what it declared', () => {
    const integration = accepted(
      descriptor(
        { displayName: 'Acme Mail', documentationUrl: 'https://acme.test/docs' },
        { capabilities: capabilities({ maxCc: 5, maxMessageBytes: 10_000_000 }) },
      ),
    );

    expect(integration).toMatchObject({
      id: 'acme-mail',
      version: '1.2.3',
      displayName: 'Acme Mail',
      documentationUrl: 'https://acme.test/docs',
      ignoredRoles: [],
      configuration: { secrets: [{ name: 'API_KEY', required: true, sensitive: true }] },
      sender: { capabilities: capabilities({ maxCc: 5, maxMessageBytes: 10_000_000 }) },
    });
  });

  it.each(['outlook', 'acme-mail', '@acme/mail', 'acme.mail_v2'])('accepts the package-style id %s', (id) => {
    expect(reasonsOf(descriptor({ id }))).toEqual([]);
  });

  it.each([
    ['a missing kind', descriptor({ kind: undefined }), '"kind" must be "mailroll.integration"'],
    ['an upper-case id', descriptor({ id: 'Acme' }), '"id" must be a package-style name'],
    ['an empty version', descriptor({ version: ' ' }), '"version" must be non-empty text'],
    ['an empty display name', descriptor({ displayName: '' }), '"displayName" must be non-empty text when present'],
    [
      'a documentation link that is not a web address',
      descriptor({ documentationUrl: 'javascript:alert(1)' }),
      '"documentationUrl" must be an http:// or https:// address',
    ],
    ['no configuration', descriptor({ configuration: undefined }), '"configuration" is not an object'],
    [
      'a settings validator that is not a function',
      descriptor({ configuration: { secrets: [], validateSettings: true } }),
      '"configuration.validateSettings" must be a function',
    ],
    ['no roles', descriptor({ roles: {} }), '"roles" declares no role'],
    [
      'a prepare that is not a function',
      descriptor({}, { prepare: 'go' }),
      '"roles.sender.prepare" must be a function',
    ],
  ])('rejects %s', (_label, raw, reason) => {
    expect(reasonsOf(raw).join('\n')).toContain(reason);
  });

  it('reports every problem at once', () => {
    expect(reasonsOf(descriptor({ kind: 'plugin', id: 'X', version: '' })).length).toBe(3);
  });

  it('rejects a sender contract this mailroll does not support and names it', () => {
    expect(reasonsOf(descriptor({}, { contract: 'sender/1' }))).toEqual([
      '"roles.sender" requires the "sender/1" contract; this mailroll supports "sender/0"',
    ]);
  });

  it.each(['mailer-v0', 'sender/00', 'sender/-1'])('rejects %s as not a sender contract', (contract) => {
    expect(reasonsOf(descriptor({}, { contract }))).toEqual([
      '"roles.sender.contract" must name a sender contract such as "sender/0"',
    ]);
  });

  it('ignores roles it does not know and reports them', () => {
    const raw = descriptor();
    const roles = { ...(raw['roles'] as Record<string, unknown>), audiences: {} };

    expect(accepted({ ...raw, roles }).ignoredRoles).toEqual(['audiences']);
  });

  it('rejects an integration whose roles are all unknown to this mailroll', () => {
    expect(reasonsOf(descriptor({ roles: { audiences: {}, reports: {} } }))).toEqual([
      'none of its roles (audiences, reports) is supported by this mailroll, which supports: sender',
    ]);
  });

  it('finds a sender role the same way it reads every other field, even when it is inherited', () => {
    const sender = (descriptor()['roles'] as Record<string, unknown>)['sender'];
    const roles = Object.create({ sender }) as object;

    expect(accepted(descriptor({ roles })).ignoredRoles).toEqual([]);
  });

  it.each([
    ['a non-boolean cc', { cc: 'yes' }, '"roles.sender.capabilities.cc" must be true or false'],
    ['a zero size limit', { maxMessageBytes: 0 }, '"roles.sender.capabilities.maxMessageBytes" must be a positive'],
    ['a fractional CC limit', { maxCc: 1.5 }, '"roles.sender.capabilities.maxCc" must be a positive'],
    ['a CC limit without CC', { cc: false, maxCc: 3 }, '"roles.sender.capabilities.maxCc" only makes sense when'],
    ['an unknown sent-copy mode', { sentCopy: 'sometimes' }, '"roles.sender.capabilities.sentCopy" must be one of'],
    [
      'an unknown recipient acceptance',
      { recipientAcceptance: 'per-message' },
      '"roles.sender.capabilities.recipientAcceptance" must be one of',
    ],
  ])('rejects incoherent capabilities: %s', (_label, overrides, reason) => {
    expect(reasonsOf(descriptor({}, { capabilities: capabilities(overrides) })).join('\n')).toContain(reason);
  });

  it.each([
    ['a lower-case name', [{ name: 'api_key', required: true, sensitive: true }], 'must be upper-case letters'],
    [
      'a name declared twice',
      [
        { name: 'API_KEY', required: true, sensitive: true },
        { name: 'API_KEY', required: false, sensitive: true },
      ],
      'is declared twice',
    ],
    [
      'a name declared twice where the first one also has a bad flag',
      [
        { name: 'API_KEY', required: 'yes', sensitive: true },
        { name: 'API_KEY', required: true, sensitive: true },
      ],
      'is declared twice',
    ],
    ['a missing flag', [{ name: 'API_KEY', required: true }], 'must say whether it is required and sensitive'],
    ['a list that is not a list', 'API_KEY', '"configuration.secrets" is not a list'],
  ])('rejects secrets with %s', (_label, secrets, reason) => {
    const raw = descriptor({ configuration: { secrets, validateSettings: () => valid({}) } });

    expect(reasonsOf(raw).join('\n')).toContain(reason);
  });

  it('turns a getter that throws into a reason instead of an exception', () => {
    const raw = descriptor();

    Object.defineProperty(raw, 'version', {
      get: () => {
        throw new Error('boom');
      },
    });

    expect(reasonsOf(raw)).toEqual(['the integration descriptor could not read "version" (Error: boom)']);
  });

  it('turns a hostile proxy into a reason instead of an exception', () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('trap');
        },
      },
    );

    expect(reasonsOf(hostile)).toEqual(['the integration descriptor could not read "kind" (Error: trap)']);
  });

  it('never iterates a list it was given, so an endless iterator cannot hang it', () => {
    const secrets = [{ name: 'API_KEY', required: true, sensitive: true }];

    Object.defineProperty(secrets, Symbol.iterator, {
      value: function* endless() {
        for (;;) {
          yield secrets[0];
        }
      },
    });

    expect(reasonsOf(descriptor({ configuration: { secrets, validateSettings: () => valid({}) } }))).toEqual([]);
  });

  it('refuses a list with an absurd length instead of walking it', () => {
    const secrets: unknown[] = [];

    secrets.length = 2 ** 32 - 1;

    expect(reasonsOf(descriptor({ configuration: { secrets, validateSettings: () => valid({}) } }))).toEqual([
      '"configuration.secrets" has more than 50 items',
    ]);
  });

  it('clips very long text that comes from the integration', () => {
    const raw = descriptor();

    Object.defineProperty(raw, 'version', {
      get: () => {
        throw new Error('x'.repeat(10_000));
      },
    });

    expect(reasonsOf(raw)[0]?.length).toBeLessThan(300);
  });

  it.each([null, undefined, 'descriptor', 42])('rejects %s as not an object', (raw) => {
    expect(reasonsOf(raw)).toEqual(['the integration descriptor is not an object']);
  });

  it('keeps a frozen snapshot that later changes to the original cannot alter', () => {
    const raw = descriptor() as {
      version: string;
      configuration: { secrets: { name: string }[] };
      roles: { sender: { capabilities: { cc: boolean } } };
    };
    const integration = accepted(raw);

    raw.version = '9.9.9';
    raw.roles.sender.capabilities.cc = false;
    raw.configuration.secrets.push({ name: 'EXTRA' });

    expect(integration.version).toBe('1.2.3');
    expect(integration.sender.capabilities.cc).toBe(true);
    expect(integration.configuration.secrets.map((secret) => secret.name)).toEqual(['API_KEY']);
    expect(Object.isFrozen(integration)).toBe(true);
    expect(Object.isFrozen(integration.sender.capabilities)).toBe(true);
    expect(Object.isFrozen(integration.configuration.secrets)).toBe(true);
  });
});

describe('the validated sender role', () => {
  it('calls prepare and validateSettings on the objects that declared them', async () => {
    const role = {
      contract: SENDER_CONTRACT,
      capabilities: capabilities(),
      marker: 'role',
      prepare(this: { marker: string }) {
        const marker = this.marker;

        return Promise.resolve({
          send: () => Promise.resolve({ outcome: 'unknown', detail: marker }),
          close: () => Promise.resolve(),
        });
      },
    };
    const configuration = {
      secrets: [],
      marker: 'configuration',
      validateSettings(this: { marker: string }) {
        return valid(this.marker);
      },
    };
    const integration = accepted(descriptor({ configuration, roles: { sender: role } }));
    const prepared = await integration.sender.prepare(context);
    const message = { to: requireEmailAddress('ana@example.test', 'to'), subject: 's', html: 'x' };

    expect(integration.configuration.validateSettings({})).toEqual(valid('configuration'));
    expect(
      prepared.ok && (await prepared.value.send(message, { attemptId: 'a', call: 1 }, { keepSentCopy: false })),
    ).toEqual({
      outcome: 'unknown',
      detail: 'role',
    });
  });

  it('turns a prepare that throws synchronously into a rejected promise', async () => {
    const integration = accepted(
      descriptor(
        {},
        {
          prepare: () => {
            throw new Error('cannot start');
          },
        },
      ),
    );

    await expect(integration.sender.prepare(context)).rejects.toThrow('cannot start');
  });

  it('refuses a prepared sender without send and close before anything is sent', async () => {
    const integration = accepted(descriptor({}, { prepare: () => Promise.resolve({}) }));

    await expect(integration.sender.prepare(context)).resolves.toEqual(
      invalid([
        'the prepared sender\'s "send" must be a function',
        'the prepared sender\'s "close" must be a function',
      ]),
    );
  });

  it('validates every result of the prepared sender against the role capabilities', async () => {
    const integration = accepted(
      descriptor({}, { prepare: () => Promise.resolve({ send: () => 'sent!', close: () => undefined }) }),
    );
    const prepared = await integration.sender.prepare(context);
    const message = { to: requireEmailAddress('ana@example.test', 'to'), subject: 's', html: 'x' };

    expect(
      prepared.ok && (await prepared.value.send(message, { attemptId: 'a', call: 1 }, { keepSentCopy: false })),
    ).toMatchObject({
      outcome: 'unknown',
      violation: 'the send result is not an object',
    });
  });

  it('turns a settings check that throws into an invalid outcome', () => {
    const integration = accepted(
      descriptor({
        configuration: {
          secrets: [],
          validateSettings: () => {
            throw new Error('bad region table');
          },
        },
      }),
    );

    expect(integration.configuration.validateSettings({})).toEqual(
      invalid(["the integration's settings check failed: Error: bad region table"]),
    );
  });

  it.each([
    ['a plain value', 'fine'],
    ['a promise', Promise.resolve(valid({}))],
    ['a failure without reasons', { ok: false, reasons: [] }],
    ['a failure whose reasons are not text', { ok: false, reasons: [42] }],
  ])('refuses a settings check that returns %s', (_label, returned) => {
    const integration = accepted(descriptor({ configuration: { secrets: [], validateSettings: () => returned } }));

    expect(integration.configuration.validateSettings({})).toEqual(
      invalid([
        "the integration's settings check did not return a validation outcome ({ ok: true, value } or { ok: false, reasons })",
      ]),
    );
  });
});

describe('ensureUniqueIntegrationIds', () => {
  it('accepts integrations with distinct ids', () => {
    const list = [accepted(descriptor({ id: 'outlook' })), accepted(descriptor({ id: 'acme-mail' }))];

    expect(ensureUniqueIntegrationIds(list)).toEqual({ ok: true, value: list });
  });

  it('rejects two integrations that share an id, official or not, without picking one', () => {
    const list = [accepted(descriptor({ id: 'outlook' })), accepted(descriptor({ id: 'outlook', version: '2.0.0' }))];

    expect(ensureUniqueIntegrationIds(list)).toEqual({
      ok: false,
      reasons: ['two active integrations share the id "outlook"; remove one of them'],
    });
  });
});
