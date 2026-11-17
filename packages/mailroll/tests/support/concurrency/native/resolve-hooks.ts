import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ResolveContext {
  readonly parentURL?: string;
}

interface ResolveResult {
  readonly url: string;
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

const coreEntry = process.env['MAILROLL_CORE_ENTRY'];

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  if (specifier === '@mailroll/core' && coreEntry !== undefined) {
    return nextResolve(pathToFileURL(coreEntry).href, context);
  }

  const relative = specifier.startsWith('./') || specifier.startsWith('../');

  if (relative && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL !== undefined) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);

    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }

  return nextResolve(specifier, context);
}
