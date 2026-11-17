import type { EmailProvider } from '@mailroll/core';

export class NullEmailProvider implements EmailProvider {
  send(): Promise<void> {
    return Promise.resolve();
  }
}
