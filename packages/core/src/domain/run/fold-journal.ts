import { optionalField } from '../kernel/optional-field';
import {
  INTERRUPTED_MESSAGE,
  type RecipientJournalEntry,
  type RecipientStatus,
  settleStatus,
  type TemplateState,
} from './template-state';

type SendIntent = Extract<RecipientJournalEntry, { readonly intent: unknown }>['intent'];

export function foldJournal(snapshot: TemplateState, entries: Iterable<RecipientJournalEntry>): TemplateState {
  const recipients: Record<string, RecipientStatus> = { ...snapshot.recipients };
  const openIntents = new Map<string, SendIntent>();
  let updatedAt = snapshot.updatedAt;
  const interrupt = (email: string, intent: SendIntent): void => {
    recipients[email] = settleStatus(recipients[email], {
      status: 'uncertain',
      at: intent.at,
      connectionId: intent.connectionId,
      message: INTERRUPTED_MESSAGE,
      ...optionalField('attemptId', intent.attemptId),
    });
  };

  for (const entry of entries) {
    if ('status' in entry) {
      recipients[entry.email] = entry.status;
      openIntents.delete(entry.email);
      updatedAt = entry.status.at;
    } else if ('intent' in entry) {
      const superseded = openIntents.get(entry.email);

      if (superseded !== undefined) {
        interrupt(entry.email, superseded);
      }

      openIntents.set(entry.email, entry.intent);
    } else {
      openIntents.delete(entry.email);
    }
  }

  for (const [email, intent] of openIntents) {
    interrupt(email, intent);
  }

  return { ...snapshot, recipients, updatedAt };
}
