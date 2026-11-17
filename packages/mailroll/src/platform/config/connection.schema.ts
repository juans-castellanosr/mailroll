import { z } from 'zod';
import { emailAddressSchema } from './email-address.schema';

export const connectionConfigSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, 'id may contain only letters, digits, underscore and dash'),
  kind: z
    .string()
    .regex(
      /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/,
      'kind must name an integration by its id, such as "acme-sender"',
    ),
  mailbox: emailAddressSchema,
  displayName: z.string().min(1).exactOptional(),
  settings: z.unknown().exactOptional(),
});

export type ConnectionConfigFile = z.infer<typeof connectionConfigSchema>;
