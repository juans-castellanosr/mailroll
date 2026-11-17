const TERMINAL_UNSAFE = /[^\P{Cc}\n]|[\p{Cf}\p{Zl}\p{Zp}]/gu;

function escapeUtf16(char: string): string {
  let escaped = '';

  for (let index = 0; index < char.length; index += 1) {
    escaped += `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }

  return escaped;
}

export function toSafeJson(value: unknown, indent?: number): string {
  const json = JSON.stringify(value, null, indent);

  if (typeof json !== 'string') {
    throw new TypeError('value cannot be represented as JSON');
  }

  return json.replace(TERMINAL_UNSAFE, escapeUtf16);
}
