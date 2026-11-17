import type { EmailAddress } from '../domain/addressing/email-address';
import { StatePersistenceError, errorSummary } from '../domain/kernel/errors';

type PersistenceStage = 'intent' | 'outcome' | 'release' | 'compact';

export type RecipientWriteStage = Exclude<PersistenceStage, 'compact'>;

type PersistenceFailure =
  readonly [stage: RecipientWriteStage, recipient: EmailAddress] | readonly [stage: 'compact', recipient: undefined];

function describeFailure(...[stage, recipient]: PersistenceFailure): string {
  switch (stage) {
    case 'intent':
      return `could not record send state before sending to ${recipient}; this run did not call the provider for it, though the history may read this attempt as uncertain`;
    case 'outcome':
      return `could not record send state after sending to ${recipient}; the history will read this attempt as uncertain, so check whether it was delivered before resending`;
    case 'release':
      return `could not record send state after the send to ${recipient} stopped without the provider accepting it (it may not have been called); the history will read this attempt as uncertain`;
    case 'compact':
      return 'could not record send state snapshot; no recorded outcome is lost, and the next live run replays the journal';
  }
}

export function toPersistenceError(error: unknown, ...failure: PersistenceFailure): StatePersistenceError {
  if (error instanceof StatePersistenceError) {
    return error;
  }

  return new StatePersistenceError(`${describeFailure(...failure)}: ${errorSummary(error)}`, failure[1], {
    cause: error,
  });
}
