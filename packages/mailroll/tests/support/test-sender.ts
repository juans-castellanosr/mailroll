import {
  INTEGRATION_KIND,
  type IntegrationDescriptor,
  invalid,
  SENDER_CONTRACT,
  type SenderContext,
  valid,
  type ValidationOutcome,
} from '@mailroll/core';

export const TEST_SENDER_ID = 'test-sender';
export const TEST_SENDER_SECRET = 'TOKEN';

export type TestSenderSettings = Readonly<Record<string, never>>;

export interface TestSenderOptions {
  readonly id?: string;
  readonly beforeReady?: (context: SenderContext<TestSenderSettings>) => Promise<void> | void;
  readonly onSend?: () => void;
  readonly onClose?: () => void;
}

function noSettings(raw: unknown): ValidationOutcome<TestSenderSettings> {
  return raw === undefined ? valid({}) : invalid(['the test sender takes no settings']);
}

export function createTestSender(options: TestSenderOptions = {}): IntegrationDescriptor<TestSenderSettings> {
  return {
    kind: INTEGRATION_KIND,
    id: options.id ?? TEST_SENDER_ID,
    version: '1.0.0',
    displayName: 'Test sender',
    configuration: {
      secrets: [{ name: TEST_SENDER_SECRET, required: true, sensitive: true }],
      validateSettings: noSettings,
    },
    roles: {
      sender: {
        contract: SENDER_CONTRACT,
        capabilities: {
          cc: true,
          replyTo: true,
          inlineAttachments: true,
          sentCopy: 'optional',
          recipientAcceptance: 'transaction',
        },
        prepare: async (context) => {
          await options.beforeReady?.(context);

          return {
            send: () => {
              options.onSend?.();

              return Promise.resolve({ outcome: 'accepted' });
            },
            close: () => {
              options.onClose?.();

              return Promise.resolve();
            },
          };
        },
      },
    },
  };
}
