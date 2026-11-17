export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  let code: unknown;

  try {
    code = Reflect.get(error, 'code');
  } catch {
    return undefined;
  }

  return typeof code === 'string' ? code : undefined;
}
