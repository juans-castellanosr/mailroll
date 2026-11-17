import type { SourceRecord } from '../domain/addressing/source-record';

export interface DataSource {
  read(): AsyncIterable<SourceRecord>;
}
