import {
  type Campaign,
  ConfigError,
  type Connection,
  type StateStore,
  type Template,
  type TemplatePlugin,
} from '@mailroll/core';
import { listTemplateDataFiles } from '../composition/resolve-template';
import type { Breadcrumb } from './breadcrumb';
import { countList, formatCounts, type ListStatus, loadListStatus } from '../status/list-status';
import type { MenuPrompts } from './menu-prompts';

export interface CatalogStepDeps {
  readonly prompts: MenuPrompts;
  readonly breadcrumb: Breadcrumb;
  readonly store: StateStore;
  readonly loadPlugin: (template: Template) => Promise<TemplatePlugin>;
}

export async function pickCampaign(campaigns: readonly Campaign[], deps: CatalogStepDeps): Promise<Campaign> {
  const [only, ...rest] = campaigns;

  if (only === undefined) {
    throw new ConfigError('no campaigns found');
  }

  if (rest.length === 0) {
    deps.breadcrumb.auto('Campaign', label(only), 'the only campaign available');

    return only;
  }

  const campaign = await deps.prompts.select(
    'Campaign',
    campaigns.map((c) => ({ name: label(c), value: c })),
  );

  deps.breadcrumb.set('Campaign', label(campaign));

  return campaign;
}

export interface TemplateOverview {
  readonly template: Template;
  readonly lists: readonly ListStatus[];
  readonly problem?: string;
}

export async function pickTemplates(campaign: Campaign, deps: CatalogStepDeps): Promise<TemplateOverview[]> {
  const overviews = await Promise.all(campaign.templates.map((template) => overview(template, deps)));
  const usable = overviews.filter((o) => o.problem === undefined);
  const [only, ...rest] = usable;

  if (only === undefined) {
    const reasons = overviews.map((o) => `${o.template.id}: ${o.problem ?? 'unavailable'}`).join('; ');

    throw new ConfigError(`campaign "${campaign.id}" has no usable template (${reasons})`);
  }

  if (rest.length === 0 && overviews.length === 1) {
    deps.breadcrumb.auto('Templates', only.template.id, 'the only template available');

    return [only];
  }

  deps.breadcrumb.show();
  const chosen = await deps.prompts.checkbox(
    'Templates (space to toggle, enter to confirm)',
    overviews.map((o) => ({
      name: `${o.template.id} — ${describeOverview(o)}`,
      value: o,
      ...(o.problem !== undefined ? { disabled: o.problem } : {}),
    })),
  );

  deps.breadcrumb.set(
    'Templates',
    chosen.length === 1 ? (chosen[0]?.template.id ?? '') : `${String(chosen.length)} selected`,
  );

  return chosen;
}

export async function pickLists(overviews: readonly TemplateOverview[], deps: CatalogStepDeps): Promise<ListStatus[]> {
  const lists: ListStatus[] = [];

  for (const overview of overviews) {
    const [only, ...rest] = overview.lists;

    if (only !== undefined && rest.length === 0) {
      lists.push(only);
      continue;
    }

    deps.breadcrumb.show();
    const chosen = await deps.prompts.checkbox(
      `CSV list(s) for "${overview.template.id}"`,
      overview.lists.map((list) => ({ name: `${list.dataFile} — ${formatCounts(countList(list))}`, value: list })),
    );

    lists.push(...chosen);
  }

  return lists;
}

export async function pickConnections(
  campaign: Campaign,
  templates: readonly Template[],
  deps: CatalogStepDeps,
): Promise<Connection[]> {
  const common = campaign.connections.filter((c) => templates.every((t) => t.connectionIds.includes(c.id)));
  const [only, ...rest] = common;

  if (only === undefined) {
    const declared = templates.map((t) => `${t.id} → [${t.connectionIds.join(', ')}]`).join('; ');

    throw new ConfigError(`the selected templates share no connection (${declared}); select them in separate runs`);
  }

  if (rest.length === 0) {
    deps.breadcrumb.auto('Connection', connectionLabel(only), 'the only connection shared by the selected templates');

    return [only];
  }

  deps.breadcrumb.show();
  const chosen = await deps.prompts.checkbox(
    'Connections to send with (several share the load round-robin)',
    common.map((c) => ({ name: connectionLabel(c), value: c })),
  );

  deps.breadcrumb.set('Connections', chosen.map((c) => c.id).join(', '));

  return chosen;
}

export function connectionLabel(connection: Connection): string {
  return `${connection.id} (${connection.mailbox})`;
}

function label(campaign: Campaign): string {
  return `${campaign.displayName} (${campaign.id})`;
}

async function overview(template: Template, deps: CatalogStepDeps): Promise<TemplateOverview> {
  try {
    const dataFiles = await listTemplateDataFiles(template);

    if (dataFiles.length === 0) {
      return { template, lists: [], problem: 'no CSV in data/' };
    }

    const prepared = await (await deps.loadPlugin(template)).prepare(template);
    const lists = await Promise.all(dataFiles.map((file) => loadListStatus(template, file, prepared, deps.store)));

    return { template, lists };
  } catch (error) {
    return {
      template,
      lists: [],
      problem: `cannot be read: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

function describeOverview(overview: TemplateOverview): string {
  const [only, ...rest] = overview.lists;

  if (only === undefined) {
    return 'unavailable';
  }

  if (rest.length === 0) {
    return formatCounts(countList(only));
  }

  return `${String(overview.lists.length)} CSV lists`;
}
