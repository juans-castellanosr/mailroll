import type { StateStore } from '@mailroll/core';
import { loadTemplatePlugin } from '../composition/load-template-plugin';
import { listTemplateDataFiles } from '../composition/resolve-template';
import { discoverCampaigns } from '../discovery/discover-campaigns';
import { type EvidenceItem, type ListCounts, countList, evidenceOf, loadListStatus } from './list-status';
import { FileStateStore } from '../state/file-state-store';

export interface ListReport {
  readonly dataFile: string;
  readonly counts: ListCounts;
  readonly evidence: readonly EvidenceItem[];
}

export interface TemplateReport {
  readonly templateId: string;
  readonly lists: readonly ListReport[];
  readonly problem?: string;
}

export interface CampaignReport {
  readonly campaignId: string;
  readonly displayName: string;
  readonly templates: readonly TemplateReport[];
}

export interface CampaignStatusOptions {
  readonly campaignsRoot: string;
  readonly store?: StateStore;
}

export async function getCampaignStatus(options: CampaignStatusOptions): Promise<CampaignReport[]> {
  const store = options.store ?? new FileStateStore();
  const campaigns = await discoverCampaigns(options.campaignsRoot);
  const reports: CampaignReport[] = [];

  for (const campaign of campaigns) {
    const templates: TemplateReport[] = [];

    for (const template of campaign.templates) {
      try {
        const files = await listTemplateDataFiles(template);

        if (files.length === 0) {
          templates.push({ templateId: template.id, lists: [], problem: 'no CSV in data/' });
          continue;
        }

        const prepared = await (await loadTemplatePlugin(template)).prepare(template);
        const lists: ListReport[] = [];

        for (const file of files) {
          const list = await loadListStatus(template, file, prepared, store);

          lists.push({
            dataFile: file,
            counts: countList(list),
            evidence: evidenceOf(list),
          });
        }

        templates.push({ templateId: template.id, lists });
      } catch (error) {
        templates.push({
          templateId: template.id,
          lists: [],
          problem: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }

    reports.push({ campaignId: campaign.id, displayName: campaign.displayName, templates });
  }

  return reports;
}
