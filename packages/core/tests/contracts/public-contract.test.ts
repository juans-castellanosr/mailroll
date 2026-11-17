import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_KIND,
  type IntegrationDescriptor,
  type Message,
  type PreparedSender,
  SENDER_CONTRACT,
  type SendOutcome,
  type SenderContext,
  ensureUniqueIntegrationIds,
  invalid,
  parseEmailAddress,
  valid,
  validateIntegrationDescriptor,
} from '@mailroll/core';

interface AcmeSettings {
  readonly region: string;
}

const acme: IntegrationDescriptor<AcmeSettings> = {
  kind: INTEGRATION_KIND,
  id: '@acme/mailroll-sender',
  version: '0.1.0',
  documentationUrl: 'https://acme.test/mailroll',
  configuration: {
    secrets: [{ name: 'API_KEY', required: true, sensitive: true }],
    validateSettings: (raw) =>
      typeof raw === 'object' && raw !== null && 'region' in raw && typeof raw.region === 'string'
        ? valid({ region: raw.region })
        : invalid(['"region" is required']),
  },
  roles: {
    sender: {
      contract: SENDER_CONTRACT,
      capabilities: {
        cc: true,
        replyTo: true,
        inlineAttachments: true,
        maxCc: 10,
        sentCopy: 'never',
        recipientAcceptance: 'per-recipient',
      },
      prepare: (context: SenderContext<AcmeSettings>): Promise<PreparedSender> =>
        Promise.resolve({
          send: (message: Message): Promise<SendOutcome> =>
            Promise.resolve(
              context.settings.region === 'eu'
                ? { outcome: 'accepted', providerMessageId: `eu-${message.to}`, ccRejected: [] }
                : { outcome: 'not-accepted', reason: 'permanent', scope: 'connection', detail: 'region closed' },
            ),
          close: () => Promise.resolve(),
        }),
    },
  },
};

function address(raw: string) {
  const parsed = parseEmailAddress(raw);

  if (!parsed.ok) {
    throw new Error('test setup: bad email');
  }

  return parsed.value;
}

describe('the public sender/0 contract', () => {
  it('lets a third party build, validate, configure, prepare and send using only @mailroll/core', async () => {
    const checked = validateIntegrationDescriptor(acme);

    if (!checked.ok) {
      throw new Error(checked.reasons.join('; '));
    }

    const settings = checked.value.configuration.validateSettings({ region: 'eu' });

    if (!settings.ok) {
      throw new Error(settings.reasons.join('; '));
    }

    const prepared = await checked.value.sender.prepare({
      connectionId: 'acme-1',
      from: address('noreply@acme.test'),
      stateKey: 'acme_1',
      settings: settings.value,
      secrets: { API_KEY: 'test-only' },
      stateDirectory: '/tmp/unused',
      interaction: { announce: () => undefined },
      interactive: false,
      signal: new AbortController().signal,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    if (!prepared.ok) {
      throw new Error(prepared.reasons.join('; '));
    }

    const message: Message = {
      to: address('ana@example.test'),
      subject: 's',
      html: 'x',
      cc: [address('cc@acme.test')],
    };
    const outcome = await prepared.value.send(message, { attemptId: 'a-1', call: 1 }, { keepSentCopy: false });

    expect(outcome).toEqual({ outcome: 'accepted', providerMessageId: 'eu-ana@example.test', ccRejected: [] });
    expect(ensureUniqueIntegrationIds([checked.value]).ok).toBe(true);
    await expect(prepared.value.close()).resolves.toBeUndefined();
  });

  it('reports the settings problems the integration itself found', () => {
    const checked = validateIntegrationDescriptor(acme);

    expect(checked.ok && checked.value.configuration.validateSettings({})).toEqual(invalid(['"region" is required']));
  });
});
