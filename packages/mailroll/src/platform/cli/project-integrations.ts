import { runSelection } from '../composition/build-runner';
import { integrationsForProject } from '../composition/integrations';

function isThisMailroll(hostModule: unknown): boolean {
  return (
    typeof hostModule === 'object' && hostModule !== null && Reflect.get(hostModule, 'runSelection') === runSelection
  );
}

export function loadIntegrationsDeclaredIn(cwd: string): Promise<readonly unknown[]> {
  return integrationsForProject({ cwd, isRunningHost: isThisMailroll });
}
