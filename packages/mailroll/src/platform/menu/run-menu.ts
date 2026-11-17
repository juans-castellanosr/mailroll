import type { RunMode, SendSelection, StateStore, Template, TemplatePlugin } from '@mailroll/core';
import type { CcPrompts } from '../cli/cc';
import { discoverCampaigns } from '../discovery/discover-campaigns';
import { Breadcrumb } from './breadcrumb';
import { pickCampaign, pickConnections, pickLists, pickTemplates } from './catalog-steps';
import type { MenuPrompts } from './menu-prompts';
import { buildSelection } from '../composition/build-selection';
import { reviewSend } from './send-review';
import { reviewStage } from './stage-review';

export type MenuOutcome =
  | { readonly kind: 'run'; readonly selection: SendSelection; readonly writePreviews: boolean }
  | { readonly kind: 'cancelled' };

export interface MenuDeps {
  readonly campaignsRoot: string;
  readonly prompts: MenuPrompts;
  readonly ccPrompts: CcPrompts;
  readonly store: StateStore;
  readonly loadPlugin: (template: Template) => Promise<TemplatePlugin>;
  readonly env: NodeJS.ProcessEnv;
  readonly random: () => number;
}

type SendType = 'qa' | 'stage' | 'live';

const SEND_TYPE_LABEL: Readonly<Record<SendType, string>> = {
  qa: 'QA (preview only)',
  stage: 'Stage/UAT (test send)',
  live: 'Live (real send)',
};

export async function runMenu(deps: MenuDeps): Promise<MenuOutcome> {
  const { prompts } = deps;
  const breadcrumb = new Breadcrumb(prompts);
  const catalog = { prompts, breadcrumb, store: deps.store, loadPlugin: deps.loadPlugin };

  const campaign = await pickCampaign(await discoverCampaigns(deps.campaignsRoot), catalog);
  const overviews = await pickTemplates(campaign, catalog);
  const lists = await pickLists(overviews, catalog);
  const connections = await pickConnections(
    campaign,
    overviews.map((o) => o.template),
    catalog,
  );

  breadcrumb.show();
  const sendType = await prompts.select<SendType>('Send type', [
    {
      name: 'QA — preview only',
      value: 'qa',
      description: 'Renders exactly what Live would send into previews/<template>/; sends nothing.',
    },
    {
      name: 'Stage/UAT — test send',
      value: 'stage',
      description: 'Real emails from real rows, all delivered to a test inbox you can edit; no history is recorded.',
    },
    {
      name: 'Live — real send',
      value: 'live',
      description: 'Sends to the recipients in each list and records who was sent.',
    },
  ]);

  breadcrumb.set('Send type', SEND_TYPE_LABEL[sendType]);

  const reviewDeps = { prompts, breadcrumb, ccPrompts: deps.ccPrompts, envCc: deps.env['CC_RECIPIENT'] };
  const connectionIds = connections.map((c) => c.id);

  if (sendType === 'stage') {
    const stage = await reviewStage(lists, {
      ...reviewDeps,
      testRecipientDefault: deps.env['TEST_RECIPIENT'],
      random: deps.random,
    });

    if (stage === undefined) {
      return { kind: 'cancelled' };
    }

    const mode: RunMode = { kind: 'test', testRecipient: stage.testRecipient };

    return {
      kind: 'run',
      selection: buildSelection({
        campaignId: campaign.id,
        targets: stage.targets,
        connectionIds,
        policy: { kind: 'force-all' },
        mode,
      }),
      writePreviews: false,
    };
  }

  const kind = sendType === 'qa' ? 'dry-run' : 'live';
  const reviewed = await reviewSend(kind, lists, connections, reviewDeps);

  if (reviewed === undefined) {
    return { kind: 'cancelled' };
  }

  return {
    kind: 'run',
    selection: buildSelection({
      campaignId: campaign.id,
      targets: reviewed.targets,
      connectionIds,
      policy: reviewed.policy,
      mode: { kind },
    }),
    writePreviews: kind === 'dry-run',
  };
}
