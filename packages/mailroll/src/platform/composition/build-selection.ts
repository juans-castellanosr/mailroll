import {
  ConfigError,
  type EmailAddress,
  type ResendPolicy,
  type RunMode,
  type SendSelection,
  type TemplateTarget,
} from '@mailroll/core';
import { z } from 'zod';
import { emailAddressSchema } from '../config/email-address.schema';
import { formatZodError } from '../config/format-zod-error';

export interface RawSelection {
  readonly campaignId: string;
  readonly targets: readonly TemplateTarget[];
  readonly connectionIds: readonly string[];
  readonly policy: ResendPolicy;
  readonly mode: RunMode;
  readonly cc?: readonly EmailAddress[];
}

const addressList = z.array(emailAddressSchema);

const policySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('failed-only') }),
  z.object({ kind: z.literal('force-all') }),
  z.object({ kind: z.literal('subset'), recipients: addressList }),
]);

const modeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('live') }),
  z.object({ kind: z.literal('dry-run') }),
  z.object({ kind: z.literal('test'), testRecipient: emailAddressSchema }),
]);

const selectionSchema = z.object({
  campaignId: z.string(),
  targets: z.array(
    z.object({
      templateId: z.string(),
      dataFile: z.string().exactOptional(),
      policy: policySchema.exactOptional(),
      cc: addressList.exactOptional(),
      dataFingerprint: z.string().exactOptional(),
    }),
  ),
  connectionIds: z.array(z.string()),
  policy: policySchema,
  mode: modeSchema,
  cc: addressList.exactOptional(),
});

export function buildSelection(input: RawSelection): SendSelection {
  const parsed = selectionSchema.safeParse(input);

  if (!parsed.success) {
    throw new ConfigError(`invalid selection: ${formatZodError(parsed.error)}`);
  }

  const raw = parsed.data;

  if (raw.campaignId.length === 0) {
    throw new ConfigError('a campaign is required');
  }

  if (raw.targets.length === 0) {
    throw new ConfigError('select at least one template');
  }

  if (raw.connectionIds.length === 0) {
    throw new ConfigError('select at least one connection');
  }

  if (raw.policy.kind === 'subset' && raw.policy.recipients.length === 0) {
    throw new ConfigError('subset policy requires at least one recipient');
  }

  const emptySubset = raw.targets.find(
    (target) => target.policy?.kind === 'subset' && target.policy.recipients.length === 0,
  );

  if (emptySubset !== undefined) {
    throw new ConfigError(`subset policy for "${emptySubset.templateId}" requires at least one recipient`);
  }

  return {
    campaignId: raw.campaignId,
    targets: dedupeTargets(raw.targets),
    connectionIds: [...new Set(raw.connectionIds)],
    policy: raw.policy,
    mode: raw.mode,
    ...(raw.cc !== undefined ? { cc: raw.cc } : {}),
  };
}

function dedupeTargets(targets: readonly TemplateTarget[]): TemplateTarget[] {
  const seen = new Set<string>();
  const unique: TemplateTarget[] = [];

  for (const target of targets) {
    const key = JSON.stringify([target.templateId, target.dataFile ?? null]);

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(target);
    }
  }

  return unique;
}
