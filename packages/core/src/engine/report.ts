import type { SendResult } from '../domain/run/send-result';

export interface RunReport {
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly notAttempted: number;
  readonly skipped: number;
  readonly heldUncertain: number;
  readonly ccRejectedMessages: number;
  readonly requiredCcRejectedMessages: number;
  readonly results: readonly SendResult[];
}

export function report(results: readonly SendResult[]): RunReport {
  let sent = 0;
  let failed = 0;
  let uncertain = 0;
  let notAttempted = 0;
  let skipped = 0;
  let heldUncertain = 0;
  let ccRejectedMessages = 0;
  let requiredCcRejectedMessages = 0;

  for (const result of results) {
    switch (result.status) {
      case 'sent':
        sent += 1;
        if (result.cc !== undefined && result.cc.rejected.length > 0) {
          ccRejectedMessages += 1;
          if (result.cc.required) {
            requiredCcRejectedMessages += 1;
          }
        }
        break;
      case 'failed':
        failed += 1;
        break;
      case 'uncertain':
        uncertain += 1;
        break;
      case 'not-attempted':
        notAttempted += 1;
        break;
      case 'skipped':
        skipped += 1;
        if (result.code === 'held-uncertain') {
          heldUncertain += 1;
        }
        break;
    }
  }

  return {
    total: results.length,
    sent,
    failed,
    uncertain,
    notAttempted,
    skipped,
    heldUncertain,
    ccRejectedMessages,
    requiredCcRejectedMessages,
    results,
  };
}

export function needsAttention(summary: RunReport): boolean {
  return (
    summary.failed +
      summary.uncertain +
      summary.notAttempted +
      summary.heldUncertain +
      summary.requiredCcRejectedMessages >
    0
  );
}
