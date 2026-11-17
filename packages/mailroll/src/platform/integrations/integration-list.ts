import { join } from 'node:path';
import { ConfigError } from '@mailroll/core';
import { z } from 'zod';
import { formatZodError } from '../config/format-zod-error';
import { readOptionalJson } from '../discovery/read-json';
import { INTEGRATION_LIST_FILE } from './project-root';

const PACKAGE_SPECIFIER =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;

const specifierSchema = z
  .string()
  .regex(
    PACKAGE_SPECIFIER,
    'each entry must name an installed package or a subpath of one, such as "acme-mailroll" or "@acme/mailroll/sender"',
  )
  .refine(
    (specifier) => !specifier.split('/').some((segment) => segment === '.' || segment === '..'),
    'a subpath may not contain "." or ".." segments',
  );

const integrationListSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  integrations: z
    .array(specifierSchema)
    .refine((specifiers) => new Set(specifiers).size === specifiers.length, 'each integration may be listed once'),
});

export function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');

  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

export function integrationListPath(projectDir: string): string {
  return join(projectDir, INTEGRATION_LIST_FILE);
}

export async function readIntegrationList(projectDir: string): Promise<readonly string[] | undefined> {
  const path = integrationListPath(projectDir);
  const parsed = await readOptionalJson(path);

  if (parsed === undefined) {
    return undefined;
  }

  const outcome = integrationListSchema.safeParse(parsed);

  if (!outcome.success) {
    throw new ConfigError(`invalid ${path}: ${formatZodError(outcome.error)}`);
  }

  return outcome.data.integrations;
}
