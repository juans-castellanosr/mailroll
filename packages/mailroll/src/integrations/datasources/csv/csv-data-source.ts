import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { type DataSource, DataSourceError, type SourceRecord } from '@mailroll/core';

export interface CsvDataSourceOptions {
  readonly path: string;
  readonly delimiter?: string;
  readonly requiredColumns?: readonly string[];
}

export class CsvDataSource implements DataSource {
  constructor(private readonly options: CsvDataSourceOptions) {}

  async *read(): AsyncIterable<SourceRecord> {
    for (const record of await this.parseFile()) {
      yield record;
    }
  }

  private async parseFile(): Promise<SourceRecord[]> {
    const { path } = this.options;
    let content: string;

    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    } catch (error) {
      const reason =
        error instanceof TypeError ? 'it is not valid UTF-8 (save it as "CSV UTF-8")' : 'it cannot be read';

      throw new DataSourceError(`unable to read CSV at "${path}": ${reason}`, { cause: error });
    }

    let rows: unknown;

    try {
      rows = parse(content, {
        columns: (header: unknown[]) => this.checkHeader(header),
        bom: true,
        skip_empty_lines: true,
        trim: false,
        delimiter: this.options.delimiter ?? ',',
      });
    } catch (error) {
      if (error instanceof DataSourceError) {
        throw error;
      }

      throw new DataSourceError(`failed to parse CSV at "${path}"`, { cause: error });
    }

    if (!Array.isArray(rows)) {
      throw new DataSourceError(`CSV at "${path}" did not produce records`);
    }

    return rows.map((row) => this.toRecord(row));
  }

  private checkHeader(header: readonly unknown[]): string[] {
    const { path } = this.options;
    const names = header.map((cell) => (typeof cell === 'string' ? cell.trim() : ''));
    const seen = new Set<string>();

    for (const [index, name] of names.entries()) {
      if (name.length === 0) {
        throw new DataSourceError(`CSV at "${path}" has an empty column name (column ${String(index + 1)})`);
      }

      if (name === '__proto__') {
        throw new DataSourceError(`CSV at "${path}" has a column named "__proto__", which is not allowed; rename it`);
      }

      if (seen.has(name)) {
        throw new DataSourceError(`CSV at "${path}" has the column "${name}" more than once`);
      }

      seen.add(name);
    }

    const missing = (this.options.requiredColumns ?? []).filter((column) => !seen.has(column));

    if (missing.length > 0) {
      const hint = names.some((name) => name.includes(';'))
        ? ' — the file looks semicolon-separated; save it comma-separated'
        : '';

      throw new DataSourceError(
        `CSV at "${path}" has no ${missing.map((m) => `"${m}"`).join(', ')} column (header: ${names.join(' | ')})${hint}`,
      );
    }

    return names;
  }

  private toRecord(row: unknown): SourceRecord {
    if (typeof row !== 'object' || row === null) {
      throw new DataSourceError(`CSV at "${this.options.path}" contains a non-object row`);
    }

    const record: Record<string, string> = {};

    for (const [key, value] of Object.entries(row)) {
      record[key] = typeof value === 'string' ? value : String(value);
    }

    return record;
  }
}
