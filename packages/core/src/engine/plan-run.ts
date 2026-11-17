import { type EmailAddress, normalizeEmail } from '../domain/addressing/email-address';
import type { ResendPolicy } from '../domain/run/send-selection';
import type { SkipCode, SkippedResult } from '../domain/run/send-result';
import type { TemplateState } from '../domain/run/template-state';
import { type Assignment, distribute } from './distribute';

export interface RunPlan {
  readonly assignments: readonly Assignment[];
  readonly skipped: readonly SkippedResult[];
}

export interface PlanRunArgs {
  readonly recipients: readonly EmailAddress[];
  readonly state: TemplateState;
  readonly policy: ResendPolicy;
  readonly connectionIds: readonly string[];
}

export function planRun(args: PlanRunArgs): RunPlan {
  const { recipients, state, policy, connectionIds } = args;
  const statusOf = (email: EmailAddress) => state.recipients[normalizeEmail(email)]?.status;

  const toSend: EmailAddress[] = [];
  const skipped: SkippedResult[] = [];
  const skip = (identifier: string, code: SkipCode, reason: string): void => {
    skipped.push({ status: 'skipped', identifier, reasons: [reason], code });
  };

  switch (policy.kind) {
    case 'pending':
      for (const recipient of recipients) {
        const status = statusOf(recipient);

        if (status === 'sent') {
          skip(recipient, 'already-sent', 'already sent (state); use force-all to resend');
        } else if (status === 'uncertain') {
          skip(
            recipient,
            'held-uncertain',
            'previous send outcome is uncertain; resend deliberately (subset or force-all) after checking',
          );
        } else {
          toSend.push(recipient);
        }
      }
      break;
    case 'failed-only':
      for (const recipient of recipients) {
        const status = statusOf(recipient);

        if (status === 'failed') {
          toSend.push(recipient);
        } else if (status === 'uncertain') {
          skip(
            recipient,
            'held-uncertain',
            'previous send outcome is uncertain; resend deliberately (subset or force-all) after checking',
          );
        } else {
          skip(recipient, 'not-failed', 'not a previous failure (failed-only policy)');
        }
      }
      break;
    case 'force-all':
      toSend.push(...recipients);
      break;
    case 'subset': {
      const requested = new Map(policy.recipients.map((r) => [normalizeEmail(r), r]));

      for (const recipient of recipients) {
        if (requested.delete(normalizeEmail(recipient))) {
          toSend.push(recipient);
        } else {
          skip(recipient, 'not-selected', 'not selected (subset policy)');
        }
      }

      for (const missing of requested.values()) {
        skip(missing, 'not-in-list', 'requested, but not in this list (or rejected by the template validator)');
      }

      break;
    }
  }

  return { assignments: distribute(toSend, connectionIds), skipped };
}
