import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { INTEGRATION_KIND, invalid, SENDER_CONTRACT, valid } from '@mailroll/core';

const OUTCOMES = ['accepted', 'unknown'];
const OUTBOX = 'acme-outbox.jsonl';

function validateSettings(raw) {
  const settings = raw ?? {};

  if (typeof settings !== 'object' || Array.isArray(settings)) {
    return invalid(['settings must be an object']);
  }

  const outcome = settings.outcome ?? 'accepted';

  if (!OUTCOMES.includes(outcome)) {
    return invalid([`settings.outcome must be one of: ${OUTCOMES.join(', ')}`]);
  }

  return valid({ outcome });
}

function record(context, entry) {
  mkdirSync(context.stateDirectory, { recursive: true });
  appendFileSync(
    join(context.stateDirectory, OUTBOX),
    `${JSON.stringify({ connectionId: context.connectionId, ...entry })}\n`,
  );
}

function outcomeFor(settings) {
  return settings.outcome === 'unknown'
    ? { outcome: 'unknown', detail: 'the acme test sender was told not to confirm' }
    : { outcome: 'accepted' };
}

export default {
  kind: INTEGRATION_KIND,
  id: 'acme-sender',
  version: '1.0.0',
  displayName: 'Acme test sender',
  configuration: { secrets: [], validateSettings },
  roles: {
    sender: {
      contract: SENDER_CONTRACT,
      capabilities: {
        cc: true,
        replyTo: true,
        inlineAttachments: true,
        sentCopy: 'never',
        recipientAcceptance: 'transaction',
      },
      prepare: (context) => {
        record(context, { event: 'prepare' });

        return Promise.resolve({
          send: (message, attempt) => {
            record(context, { event: 'send', to: message.to, attemptId: attempt.attemptId });

            return Promise.resolve(outcomeFor(context.settings));
          },
          close: () => Promise.resolve(),
        });
      },
    },
  },
};
