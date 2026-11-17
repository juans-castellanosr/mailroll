import type { EmailAddress } from '../domain/addressing/email-address';

export interface Assignment {
  readonly recipient: EmailAddress;
  readonly connectionId: string;
}

export function distribute(
  recipients: readonly EmailAddress[],
  connectionIds: readonly string[],
): readonly Assignment[] {
  const n = connectionIds.length;

  if (n === 0) {
    return [];
  }

  const assignments: Assignment[] = [];

  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    const connectionId = connectionIds[i % n];

    if (recipient !== undefined && connectionId !== undefined) {
      assignments.push({ recipient, connectionId });
    }
  }

  return assignments;
}
