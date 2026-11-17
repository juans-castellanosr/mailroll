import { z } from 'zod';
import { emailAddressSchema } from './email-address.schema';

const pacingSchema = z.strictObject({
  delayBetweenSendsMs: z.number().int().nonnegative().default(250),
  maxRetries: z.number().int().nonnegative().default(3),
  baseBackoffMs: z.number().int().positive().default(500),
  maxBackoffMs: z.number().int().positive().default(15_000),
  maxRetryAfterMs: z.number().int().positive().default(900_000),
  maxThrottleWaitMs: z.number().int().positive().default(3_600_000),
});

export const templateConfigSchema = z.strictObject({
  ccPolicy: z.enum(['forbidden', 'required', 'optional']),
  connectionIds: z.array(z.string().min(1)).min(1),
  subjectTemplate: z.string().min(1).exactOptional(),
  context: z.record(z.string(), z.string()),
  pacing: pacingSchema.exactOptional(),
  saveToSentItems: z.boolean().exactOptional(),
  cc: z.array(emailAddressSchema).min(1).exactOptional(),
});

export type TemplateConfigFile = z.infer<typeof templateConfigSchema>;
export type PacingConfig = z.infer<typeof pacingSchema>;
