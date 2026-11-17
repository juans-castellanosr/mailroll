import type { Connection } from '../domain/catalog/connection';

export interface AuthProvider {
  getAccessToken(connection: Connection): Promise<string>;
}
