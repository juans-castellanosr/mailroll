export type FieldRead =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

export type KeyRead =
  { readonly ok: true; readonly keys: readonly string[] } | { readonly ok: false; readonly error: string };

export type ItemRead =
  { readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly error: string };

const MAX_UNTRUSTED_TEXT = 200;

export function readFields(source: unknown, names: readonly string[]): FieldRead {
  if (!isObjectLike(source)) {
    return { ok: false, error: 'is not an object' };
  }

  const fields: Record<string, unknown> = {};

  for (const name of names) {
    try {
      fields[name] = Reflect.get(source, name);
    } catch (error) {
      return { ok: false, error: `could not read "${name}" (${describeThrown(error)})` };
    }
  }

  return { ok: true, fields };
}

export function readOwnKeys(source: unknown): KeyRead {
  if (!isObjectLike(source)) {
    return { ok: false, error: 'is not an object' };
  }

  try {
    return { ok: true, keys: Object.keys(source) };
  } catch (error) {
    return { ok: false, error: `could not list its keys (${describeThrown(error)})` };
  }
}

export function readItems(source: unknown, maxItems: number): ItemRead {
  try {
    if (!Array.isArray(source)) {
      return { ok: false, error: 'is not a list' };
    }

    const length: unknown = Reflect.get(source, 'length');

    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return { ok: false, error: 'is not a list with a valid length' };
    }

    if (length > maxItems) {
      return { ok: false, error: `has more than ${String(maxItems)} items` };
    }

    const items: unknown[] = [];

    for (let index = 0; index < length; index += 1) {
      items.push(Reflect.get(source, index));
    }

    return { ok: true, items };
  } catch (error) {
    return { ok: false, error: `could not read the list (${describeThrown(error)})` };
  }
}

export function describeThrown(error: unknown): string {
  try {
    return clipUntrustedText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } catch {
    return 'an error that could not be described';
  }
}

export function clipUntrustedText(text: string): string {
  return text.length > MAX_UNTRUSTED_TEXT ? `${text.slice(0, MAX_UNTRUSTED_TEXT)}…` : text;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
