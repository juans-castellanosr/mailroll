import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedTemplate } from '@mailroll/core';

export interface StagedList {
  readonly template: ResolvedTemplate;
  readonly snapshotPath: string;
  readonly journalPath: string;
}

export interface ListFiles {
  readonly snapshot?: string;
  readonly journal?: string;
}

export function listTemplate(statePath: string): ResolvedTemplate {
  return {
    id: 'welcome',
    campaignId: 'acme/newsletter',
    ccPolicy: 'optional',
    connectionIds: ['outlook-1'],
    dir: '',
    dataDir: '',
    stateDir: '',
    assetsDir: '',
    compiledHtmlPath: '',
    context: {},
    dataFile: 'list.csv',
    dataPath: '',
    statePath,
  };
}

export function stageList(root: string, files: ListFiles): StagedList {
  const dir = mkdtempSync(join(root, 'list-'));
  const snapshotPath = join(dir, 'list.json');
  const journalPath = join(dir, 'list.jsonl');

  if (files.snapshot !== undefined) {
    writeFileSync(snapshotPath, files.snapshot, { mode: 0o600 });
  }

  if (files.journal !== undefined) {
    writeFileSync(journalPath, files.journal, { mode: 0o600 });
  }

  return { template: listTemplate(snapshotPath), snapshotPath, journalPath };
}
