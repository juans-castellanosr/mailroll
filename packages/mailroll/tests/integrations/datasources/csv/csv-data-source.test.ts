import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSourceError, type SourceRecord } from '@mailroll/core';
import { CsvDataSource } from '../../../../src/integrations/datasources/csv/csv-data-source';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/recipients.sample.csv', import.meta.url));

async function collect(source: CsvDataSource): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];

  for await (const record of source.read()) {
    out.push(record);
  }

  return out;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-csv-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CsvDataSource', () => {
  it('parses every data row into a keyed record (unvalidated)', async () => {
    const records = await collect(new CsvDataSource({ path: FIXTURE }));

    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ username: 'ada.lovelace', password: 'Fake-Pass-1' });
    expect(records[4]?.['password']).toBe('');
  });

  it('preserves values verbatim (no trimming)', async () => {
    const path = join(dir, 'spaced.csv');

    writeFileSync(path, 'username,email,password\n u , a@b.co ,  p w  \n', 'utf8');

    const [record] = await collect(new CsvDataSource({ path }));

    expect(record?.['password']).toBe('  p w  ');
  });

  it('throws DataSourceError when the file is missing', async () => {
    await expect(collect(new CsvDataSource({ path: join(dir, 'nope.csv') }))).rejects.toThrow(DataSourceError);
  });

  it('throws DataSourceError on a ragged row', async () => {
    const path = join(dir, 'ragged.csv');

    writeFileSync(path, 'a,b,c\n1,2,3\n1,2\n', 'utf8');
    await expect(collect(new CsvDataSource({ path }))).rejects.toThrow(DataSourceError);
  });

  it.each([
    ['email,name,email\na@x.co,A,b@x.co\n', /column "email" more than once/],
    ['email,,name\na@x.co,,A\n', /empty column name/],
    ['email,__proto__\na@x.co,x\n', /column named "__proto__"/],
  ])('refuses an ambiguous header %j', async (content, message) => {
    const path = join(dir, 'ambiguous.csv');

    writeFileSync(path, content, 'utf8');
    await expect(collect(new CsvDataSource({ path }))).rejects.toThrow(message);
  });

  it('refuses a file that is not valid UTF-8 instead of sending garbled text', async () => {
    const path = join(dir, 'latin1.csv');

    writeFileSync(path, Buffer.from([...Buffer.from('email,name\na@x.co,Jos'), 0xe9, 0x0a]));
    await expect(collect(new CsvDataSource({ path }))).rejects.toThrow(/not valid UTF-8/);
  });

  it('refuses a file without a required column once, and hints at a semicolon-separated file', async () => {
    const path = join(dir, 'semicolon.csv');

    writeFileSync(path, 'email;name\na@x.co;A\n', 'utf8');
    await expect(collect(new CsvDataSource({ path, requiredColumns: ['email'] }))).rejects.toThrow(
      /no "email" column.*semicolon-separated/,
    );
  });
});
