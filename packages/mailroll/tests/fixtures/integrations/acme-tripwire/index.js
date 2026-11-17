import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTEGRATION_KIND, SENDER_CONTRACT, valid } from '@mailroll/core';

writeFileSync(join(process.cwd(), 'acme-tripwire-was-loaded'), new Date().toISOString());

export default {
  kind: INTEGRATION_KIND,
  id: 'acme-tripwire',
  version: '1.0.0',
  configuration: { secrets: [], validateSettings: () => valid({}) },
  roles: {
    sender: {
      contract: SENDER_CONTRACT,
      capabilities: {
        cc: false,
        replyTo: false,
        inlineAttachments: false,
        sentCopy: 'never',
        recipientAcceptance: 'transaction',
      },
      prepare: () => Promise.reject(new Error('acme-tripwire must never be prepared')),
    },
  },
};
