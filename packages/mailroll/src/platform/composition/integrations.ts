import {
  ConfigError,
  ensureUniqueIntegrationIds,
  type ValidatedIntegration,
  validateIntegrationDescriptor,
} from '@mailroll/core';
import {
  type IntegrationSource,
  loadProjectIntegrations,
  type ProjectIntegrationOptions,
} from '../integrations/load-project-integrations';

export function activateIntegrationSources(
  sources: readonly IntegrationSource[],
): ReadonlyMap<string, ValidatedIntegration> {
  const validated = sources.map((source) => {
    const outcome = validateIntegrationDescriptor(source.descriptor);

    if (!outcome.ok) {
      throw new ConfigError(`${source.origin} is not a valid mailroll integration: ${outcome.reasons.join('; ')}`);
    }

    return { integration: outcome.value, origin: source.origin };
  });
  const unique = ensureUniqueIntegrationIds(validated.map((entry) => entry.integration));

  if (!unique.ok) {
    const duplicates = [...new Set(validated.map((entry) => entry.integration.id))]
      .map((id) => ({ id, origins: validated.filter((entry) => entry.integration.id === id).map((e) => e.origin) }))
      .filter((group) => group.origins.length > 1)
      .map(
        (group) =>
          `two active integrations share the id "${group.id}" (${group.origins.join(' and ')}); remove one of them`,
      );

    throw new ConfigError((duplicates.length > 0 ? duplicates : unique.reasons).join('; '));
  }

  return new Map(unique.value.map((integration) => [integration.id, integration]));
}

export function activateIntegrations(descriptors: readonly unknown[]): ReadonlyMap<string, ValidatedIntegration> {
  return activateIntegrationSources(
    descriptors.map((descriptor, index) => ({ descriptor, origin: `integration #${String(index + 1)}` })),
  );
}

export async function integrationsForProject(options: ProjectIntegrationOptions): Promise<readonly unknown[]> {
  const sources = await loadProjectIntegrations(options);

  activateIntegrationSources(sources);

  return sources.map((source) => source.descriptor);
}
