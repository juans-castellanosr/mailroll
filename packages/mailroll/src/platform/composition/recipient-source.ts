import { type DataSource, EMAIL_FIELD } from '@mailroll/core';
import { CsvDataSource } from '../../integrations/datasources/csv/csv-data-source';

export function recipientSource(path: string): DataSource {
  return new CsvDataSource({ path, requiredColumns: [EMAIL_FIELD] });
}
