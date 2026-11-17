const UNSAFE = /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]/gu;

export function forTerminal(text: string): string {
  return text.replace(UNSAFE, (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`);
}
