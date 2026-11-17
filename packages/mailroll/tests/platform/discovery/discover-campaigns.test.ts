import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { discoverCampaigns } from '../../../src/platform/discovery/discover-campaigns';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ee-disc-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function scaffold(connectionIds: readonly string[]): void {
  const base = join(root, 'acme', 'newsletter');

  writeJson(join(base, 'campaign.config.json'), { displayName: 'Newsletter' });
  writeJson(join(base, 'connections', 'outlook-1.json'), {
    id: 'outlook-1',
    kind: 'outlook',
    mailbox: 'sender@example.org',
  });
  writeJson(join(base, 'templates', 'welcome', 'config', 'template.config.json'), {
    ccPolicy: 'forbidden',
    connectionIds,
    context: { portalUrl: 'https://x/y' },
  });
}

describe('discoverCampaigns', () => {
  it('loads a self-contained campaign with its connections and templates', async () => {
    scaffold(['outlook-1']);

    const campaigns = await discoverCampaigns(root);

    expect(campaigns).toHaveLength(1);

    const campaign = campaigns[0];

    expect(campaign?.id).toBe('acme/newsletter');
    expect(campaign?.connections.map((c) => c.id)).toEqual(['outlook-1']);
    expect(campaign?.templates.map((t) => t.id)).toEqual(['welcome']);
    expect(campaign?.templates[0]?.context['portalUrl']).toBe('https://x/y');
  });

  it('rejects a template referencing an unknown connection', async () => {
    scaffold(['nonexistent']);
    await expect(discoverCampaigns(root)).rejects.toThrow(ConfigError);
  });

  it('returns nothing for an empty root', async () => {
    expect(await discoverCampaigns(root)).toEqual([]);
  });
});

describe('discoverCampaigns — secret key collisions', () => {
  it('refuses two campaigns that would share environment secrets and token caches', async () => {
    for (const [group, name] of [
      ['acme', 'spring-2026'],
      ['acme-spring', '2026'],
    ] as const) {
      const base = join(root, group, name);

      writeJson(join(base, 'campaign.config.json'), { displayName: name });
      writeJson(join(base, 'connections', 'outlook-1.json'), {
        id: 'outlook-1',
        kind: 'outlook',
        mailbox: `${name}@org.com`,
      });
    }

    await expect(discoverCampaigns(root)).rejects.toThrow(/would share secrets and token caches/);
  });
});
