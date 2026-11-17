import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, type Template } from '@mailroll/core';
import { resolveDataFile, resolveTemplate } from '../../../src/platform/composition/resolve-template';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ee-resolve-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function template(dir: string): Template {
  return {
    id: 'welcome',
    campaignId: 'acme/newsletter',
    ccPolicy: 'forbidden',
    connectionIds: ['outlook-1'],
    dir,
    dataDir: join(dir, 'data'),
    stateDir: join(dir, '.state'),
    assetsDir: join(dir, 'assets'),
    compiledHtmlPath: join(dir, 'compiled.html'),
    context: {},
  };
}

function withData(name: string, files: readonly string[]): Template {
  const dir = join(root, name);

  mkdirSync(join(dir, 'data'), { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, 'data', file), 'email\n', 'utf8');
  }

  return template(dir);
}

describe('resolveTemplate', () => {
  it('derives per-CSV data and state paths (state key sanitized)', () => {
    const t = template(join(root, 'paths'));
    const resolved = resolveTemplate(t, 'Grupo B.csv');

    expect(resolved.dataPath).toBe(join(t.dataDir, 'Grupo B.csv'));
    expect(resolved.statePath).toBe(join(t.stateDir, 'Grupo_B.json'));
    expect(resolved.dataFile).toBe('Grupo B.csv');
  });
});

describe('resolveDataFile', () => {
  it('returns a requested file that exists', async () => {
    const t = withData('req-ok', ['a.csv', 'b.csv']);

    expect(await resolveDataFile(t, 'b.csv')).toBe('b.csv');
  });

  it('throws when the requested file is missing', async () => {
    const t = withData('req-missing', ['a.csv']);

    await expect(resolveDataFile(t, 'nope.csv')).rejects.toThrow(ConfigError);
  });

  it('defaults to recipients.csv when present', async () => {
    const t = withData('default-recipients', ['recipients.csv', 'other.csv']);

    expect(await resolveDataFile(t, undefined)).toBe('recipients.csv');
  });

  it('defaults to the sole CSV when there is exactly one', async () => {
    const t = withData('single', ['only.csv']);

    expect(await resolveDataFile(t, undefined)).toBe('only.csv');
  });

  it('throws when several CSVs exist and none is requested', async () => {
    const t = withData('ambiguous', ['a.csv', 'b.csv']);

    await expect(resolveDataFile(t, undefined)).rejects.toThrow(ConfigError);
  });

  it('throws when no CSV exists', async () => {
    const t = withData('none', []);

    await expect(resolveDataFile(t, undefined)).rejects.toThrow(ConfigError);
  });
});
