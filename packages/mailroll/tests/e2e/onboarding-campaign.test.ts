import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSelection, getCampaignStatus, runSelection } from 'mailroll';
import { createTestSender } from '../support/test-sender';

const CAMPAIGNS = resolve(import.meta.dirname, '../fixtures/campaigns');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const QUICKSTART_CONNECTION_KIND = [createTestSender({ id: 'outlook' })];

let previews: string;

beforeEach(() => {
  previews = mkdtempSync(join(tmpdir(), 'mailroll-example-'));
});
afterEach(() => {
  rmSync(previews, { recursive: true, force: true });
});

describe('the onboarding campaign fixture', () => {
  it('renders every valid row and skips the invalid one in a dry run', async () => {
    const selection = buildSelection({
      campaignId: 'acme/onboarding',
      targets: [{ templateId: 'welcome' }],
      connectionIds: ['outlook-1'],
      policy: { kind: 'pending' },
      mode: { kind: 'dry-run' },
    });
    const [result] = await runSelection(selection, {
      campaignsRoot: CAMPAIGNS,
      logger: silent,
      previewDir: previews,
      integrations: QUICKSTART_CONNECTION_KIND,
    });

    expect(result?.report).toMatchObject({ sent: 3, failed: 0, skipped: 1 });

    const dir = join(previews, 'welcome', 'recipients');
    const files = readdirSync(dir).sort();

    expect(files).toEqual(['0001-ada@example.com.html', '0002-grace@example.com.html', '0003-alan@example.org.html']);

    const ada = readFileSync(join(dir, files[0] ?? ''), 'utf8');

    expect(ada).toContain('Hi Ada,');
    expect(ada).toContain('Your Pro plan is ready.');
    expect(ada).toContain('https://example.com/start');
  });

  it('reports the same numbers through getCampaignStatus', async () => {
    const [campaign] = await getCampaignStatus({ campaignsRoot: CAMPAIGNS });

    expect(campaign?.templates[0]).toMatchObject({
      templateId: 'welcome',
      lists: [{ dataFile: 'recipients.csv', counts: { total: 3, sent: 0, pending: 3, rejected: 1 } }],
    });
  });
});
