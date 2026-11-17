import { describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { campaignConfigSchema } from '../../../src/platform/config/campaign.schema';
import { connectionConfigSchema } from '../../../src/platform/config/connection.schema';
import { formatZodError } from '../../../src/platform/config/format-zod-error';
import { connectionEnvKey, resolveDeclaredSecrets } from '../../../src/platform/config/resolve-connection-secrets';
import { templateConfigSchema } from '../../../src/platform/config/template.schema';

describe('connectionConfigSchema', () => {
  it('accepts a valid declaration', () => {
    expect(connectionConfigSchema.safeParse({ id: 'outlook-1', kind: 'outlook', mailbox: 'a@b.co' }).success).toBe(
      true,
    );
  });
  it.each([
    { id: 'x', kind: 'Not An Integration', mailbox: 'a@b.co' },
    { id: 'x', kind: 'outlook', mailbox: 'not-email' },
    { id: 'x', kind: 'outlook', mailbox: 'a@b.co', extra: 1 },
  ])('rejects invalid declaration %j', (input) => {
    expect(connectionConfigSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['a Unicode local part', 'josé@ejemplo.example', 'josé@ejemplo.example'],
    ['a Unicode domain', 'ada@bücher.example', 'ada@bücher.example'],
    ['an atext character other validators drop', 'user!tag@example.com', 'user!tag@example.com'],
    ['surrounding spaces', '  sender@example.com ', 'sender@example.com'],
  ])('accepts a mailbox with %s, with the same rule as recipients and CC', (_case, mailbox, expected) => {
    const parsed = connectionConfigSchema.safeParse({ id: 'outlook-1', kind: 'outlook', mailbox });

    expect(parsed.success && parsed.data.mailbox).toBe(expected);
  });

  it('reports an invalid mailbox under its field, with the domain reason', () => {
    const parsed = connectionConfigSchema.safeParse({ id: 'outlook-1', kind: 'outlook', mailbox: 'a@b.c' });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : formatZodError(parsed.error)).toBe(
      'mailbox: email is not a valid address (invalid domain)',
    );
  });
});

describe('templateConfigSchema', () => {
  it('accepts a valid config and applies pacing defaults', () => {
    const parsed = templateConfigSchema.safeParse({
      ccPolicy: 'forbidden',
      connectionIds: ['outlook-1'],
      context: { portalUrl: 'https://x/y' },
      pacing: {},
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pacing?.maxRetries).toBe(3);
    }
  });
  it('accepts an optional saveToSentItems flag and rejects a non-boolean', () => {
    const base = { ccPolicy: 'required', connectionIds: ['outlook-1'], context: {} };
    const on = templateConfigSchema.safeParse({ ...base, saveToSentItems: true });

    expect(on.success && on.data.saveToSentItems).toBe(true);

    const absent = templateConfigSchema.safeParse(base);

    expect(absent.success && absent.data.saveToSentItems).toBeUndefined();
    expect(templateConfigSchema.safeParse({ ...base, saveToSentItems: 'yes' }).success).toBe(false);
  });

  it('requires at least one connection', () => {
    expect(templateConfigSchema.safeParse({ ccPolicy: 'forbidden', connectionIds: [], context: {} }).success).toBe(
      false,
    );
  });
});

describe('campaignConfigSchema', () => {
  it('requires displayName', () => {
    expect(campaignConfigSchema.safeParse({ displayName: 'Newsletter' }).success).toBe(true);
    expect(campaignConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe('resolveDeclaredSecrets', () => {
  const declared = [
    { name: 'TENANT_ID', required: true, sensitive: false },
    { name: 'CLIENT_ID', required: true, sensitive: false },
    { name: 'REGION', required: false, sensitive: false },
  ];

  it('builds a deterministic env key', () => {
    expect(connectionEnvKey('acme/newsletter', 'outlook-1', 'CLIENT_ID')).toBe('ACME_NEWSLETTER__OUTLOOK_1__CLIENT_ID');
  });

  it('resolves the declared secrets from the environment, under the same variable names as before', () => {
    const env = {
      ACME_NEWSLETTER__OUTLOOK_1__TENANT_ID: ' t ',
      ACME_NEWSLETTER__OUTLOOK_1__CLIENT_ID: 'c',
    };

    expect(resolveDeclaredSecrets('acme/newsletter', 'outlook-1', declared, env)).toEqual({
      TENANT_ID: 't',
      CLIENT_ID: 'c',
    });
  });

  it('throws the same ConfigError as before when a required secret is missing', () => {
    expect(() => resolveDeclaredSecrets('acme/newsletter', 'outlook-1', declared, {})).toThrow(
      new ConfigError('missing environment secret ACME_NEWSLETTER__OUTLOOK_1__TENANT_ID'),
    );
  });
});
