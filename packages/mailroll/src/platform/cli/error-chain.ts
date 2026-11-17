const MAX_DEPTH = 5;

export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;

  while (current !== undefined && chain.length < MAX_DEPTH) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain;
}

export function findInChain<E extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => E,
): E | undefined {
  return errorChain(error).find((link): link is E => link instanceof type);
}

export function isPromptExit(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

export function describeError(error: unknown): string {
  const parts: string[] = [];

  for (const link of errorChain(error)) {
    const text = link instanceof Error ? link.message : typeof link === 'string' ? link : 'non-error value thrown';

    if (!parts.some((part) => part.includes(text))) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join('\n  caused by: ') : 'unknown error';
}
