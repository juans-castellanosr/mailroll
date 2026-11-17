import { z } from 'zod';

export const campaignConfigSchema = z.strictObject({
  displayName: z.string().min(1),
});

export type CampaignConfigFile = z.infer<typeof campaignConfigSchema>;
