import { type CliContext, EXIT } from '../context';
import { styled } from '../output';
import { describeEvidence, formatCounts } from '../../status/list-status';
import { getCampaignStatus } from '../../status/campaign-status';

export async function statusCommand(
  ctx: CliContext,
  options: { readonly json?: boolean | undefined },
): Promise<number> {
  const campaigns = await getCampaignStatus({ campaignsRoot: ctx.campaignsRoot });
  const exitCode = campaigns.some((campaign) => campaign.templates.some((template) => template.problem !== undefined))
    ? EXIT.attention
    : EXIT.ok;

  if (options.json === true) {
    ctx.out.json(campaigns);

    return exitCode;
  }

  if (campaigns.length === 0) {
    ctx.out.info(`No campaigns found under ${ctx.campaignsRoot} (expected <group>/<name>/campaign.config.json).`);

    return EXIT.ok;
  }

  for (const campaign of campaigns) {
    ctx.out.data(styled('strong', campaign.campaignId), ` — ${campaign.displayName}`);
    for (const template of campaign.templates) {
      if (template.problem !== undefined) {
        ctx.out.data(`  ${template.templateId}: `, styled('warning', 'unavailable'), ` — ${template.problem}`);
        continue;
      }

      for (const list of template.lists) {
        ctx.out.data(`  ${template.templateId} · ${list.dataFile}: ${formatCounts(list.counts)}`);

        for (const item of list.evidence) {
          ctx.out.data(`    ${describeEvidence(item)}`);
        }
      }
    }
  }

  return exitCode;
}
