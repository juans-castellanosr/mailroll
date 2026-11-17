export function requiredField(raw: string | undefined, label: string, reasons: string[]): string {
  const value = (raw ?? '').trim();

  if (value.length === 0) {
    reasons.push(`${label} is missing or empty`);
  }

  return value;
}
