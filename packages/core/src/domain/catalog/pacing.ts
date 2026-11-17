import { readFields } from '../kernel/read-untrusted';

export interface Pacing {
  readonly delayBetweenSendsMs: number;
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxRetryAfterMs: number;
  readonly maxThrottleWaitMs: number;
}

const PACING_FIELDS: readonly (keyof Pacing)[] = [
  'delayBetweenSendsMs',
  'maxRetries',
  'baseBackoffMs',
  'maxBackoffMs',
  'maxRetryAfterMs',
  'maxThrottleWaitMs',
];

export function problemsOfPacing(raw: unknown): readonly string[] {
  const read = readFields(raw, PACING_FIELDS);

  if (!read.ok) {
    return [`the pacing ${read.error}`];
  }

  const problems = PACING_FIELDS.flatMap((name) => {
    const value = read.fields[name];

    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? []
      : [`"${name}" must be a finite number of zero or more`];
  });
  const maxRetries = read.fields['maxRetries'];

  return typeof maxRetries === 'number' && Number.isFinite(maxRetries) && !Number.isSafeInteger(maxRetries)
    ? [...problems, '"maxRetries" must be a whole number']
    : problems;
}

export const DEFAULT_PACING: Pacing = {
  delayBetweenSendsMs: 250,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
  maxRetryAfterMs: 900_000,
  maxThrottleWaitMs: 3_600_000,
};
