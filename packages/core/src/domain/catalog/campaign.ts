import type { Connection } from './connection';
import type { Template } from './template';

export interface Campaign {
  readonly id: string;
  readonly displayName: string;
  readonly connections: readonly Connection[];
  readonly templates: readonly Template[];
}
