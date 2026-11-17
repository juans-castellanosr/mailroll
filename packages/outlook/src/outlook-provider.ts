import type { AuthProvider, Connection, EmailProvider, Message } from '@mailroll/core';
import { GraphClient } from './graph-client';

export interface OutlookProviderOptions {
  readonly saveToSentItems: boolean;
}

export class OutlookProvider implements EmailProvider {
  private readonly client: GraphClient;

  constructor(connection: Connection, auth: AuthProvider, options: OutlookProviderOptions) {
    this.client = new GraphClient({
      getAccessToken: () => auth.getAccessToken(connection),
      saveToSentItems: options.saveToSentItems,
    });
  }

  send(message: Message): Promise<void> {
    return this.client.sendMail(message);
  }
}
