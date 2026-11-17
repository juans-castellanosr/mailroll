import { join } from 'node:path';
import { type Campaign, ConfigError } from '@mailroll/core';
import { safeSegment } from '../config/connection-key';
import { listDirs } from './list-dirs';
import { loadCampaign } from './load-campaign';

export async function discoverCampaigns(campaignsRoot: string): Promise<Campaign[]> {
  const campaigns: Campaign[] = [];

  for (const group of await listDirs(campaignsRoot)) {
    for (const name of await listDirs(join(campaignsRoot, group))) {
      campaigns.push(await loadCampaign(campaignsRoot, group, name));
    }
  }

  rejectKeyCollisions(campaigns);

  return campaigns;
}

function rejectKeyCollisions(campaigns: readonly Campaign[]): void {
  const owners = new Map<string, string>();

  for (const campaign of campaigns) {
    const key = safeSegment(campaign.id);
    const other = owners.get(key);

    if (other !== undefined) {
      throw new ConfigError(
        `campaigns "${other}" and "${campaign.id}" would share secrets and token caches (both normalize to "${key}"); rename one`,
      );
    }

    owners.set(key, campaign.id);
  }
}
