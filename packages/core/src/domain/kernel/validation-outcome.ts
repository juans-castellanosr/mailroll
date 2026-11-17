export type ValidationOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasons: readonly string[] };

export const valid = <T>(value: T): ValidationOutcome<T> => ({ ok: true, value });

export const invalid = <T>(reasons: readonly string[]): ValidationOutcome<T> => ({
  ok: false,
  reasons,
});
