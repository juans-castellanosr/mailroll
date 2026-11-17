import { INTEGRATION_KIND } from '../../src/contracts/integration-descriptor';
import {
  SENDER_CONTRACT,
  type SendAttempt,
  type SenderCapabilities,
  type SendPreferences,
} from '../../src/contracts/sender';
import { validateIntegrationDescriptor } from '../../src/contracts/validate-descriptor';
import { parseEmailAddress } from '../../src/domain/addressing/email-address';
import { valid } from '../../src/domain/kernel/validation-outcome';
import type { Message } from '../../src/domain/messaging/message';
import type { PreparedConnectionSender } from '../../src/engine/run-engine';
import type { Logger } from '../../src/ports/logger';

export const PER_RECIPIENT: SenderCapabilities = {
  cc: true,
  replyTo: true,
  inlineAttachments: true,
  sentCopy: 'never',
  recipientAcceptance: 'per-recipient',
};

export const TRANSACTION: SenderCapabilities = { ...PER_RECIPIENT, recipientAcceptance: 'transaction' };

export interface SenderCall {
  readonly to: string;
  readonly cc: readonly string[];
  readonly attempt: SendAttempt;
}

export type SendScript = (message: Message, attempt: SendAttempt) => unknown;

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class ScriptedSender {
  readonly calls: SenderCall[] = [];

  constructor(private readonly script: SendScript) {}

  async prepare(capabilities: SenderCapabilities): Promise<PreparedConnectionSender> {
    const checked = validateIntegrationDescriptor({
      kind: INTEGRATION_KIND,
      id: 'scripted-sender',
      version: '1.0.0',
      configuration: { secrets: [], validateSettings: (raw: unknown) => valid(raw) },
      roles: {
        sender: {
          contract: SENDER_CONTRACT,
          capabilities,
          prepare: () =>
            Promise.resolve({
              send: (message: Message, attempt: SendAttempt, _preferences: SendPreferences) => {
                this.calls.push({ to: message.to, cc: message.cc ?? [], attempt });

                return this.script(message, attempt);
              },
              close: () => Promise.resolve(),
            }),
        },
      },
    });

    if (!checked.ok) {
      throw new Error(checked.reasons.join('; '));
    }

    const from = parseEmailAddress('noreply@acme.test');

    if (!from.ok) {
      throw new Error('test setup: bad sender address');
    }

    const prepared = await checked.value.sender.prepare({
      connectionId: 'x',
      from: from.value,
      stateKey: 'x',
      settings: {},
      secrets: {},
      stateDirectory: '',
      interaction: { announce: () => undefined },
      interactive: false,
      signal: new AbortController().signal,
      logger: silent,
    });

    if (!prepared.ok) {
      throw new Error(prepared.reasons.join('; '));
    }

    return { capabilities: checked.value.sender.capabilities, sender: prepared.value };
  }
}
