import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { loadTemplate } from '../../../src/platform/discovery/load-template';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-tpl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'template.config.json'),
    JSON.stringify({ connectionIds: ['outlook-1'], context: {}, ...config }),
    'utf8',
  );
}

describe('loadTemplate — default CC', () => {
  it('loads the default CC list', async () => {
    writeConfig({ ccPolicy: 'required', cc: ['coord@org.co', 'second@org.co'] });
    expect((await loadTemplate('c', dir)).cc).toEqual(['coord@org.co', 'second@org.co']);
  });

  it('leaves cc absent when the config does not declare one', async () => {
    writeConfig({ ccPolicy: 'required' });
    expect((await loadTemplate('c', dir)).cc).toBeUndefined();
  });

  it.each([
    { ccPolicy: 'required', cc: ['not-an-email'] },
    { ccPolicy: 'required', cc: ['a@org.co', 'A@org.co'] },
    { ccPolicy: 'required', cc: [] },
    { ccPolicy: 'forbidden', cc: ['a@org.co'] },
  ])('rejects %j', async (config) => {
    writeConfig(config);
    await expect(loadTemplate('c', dir)).rejects.toThrow(ConfigError);
  });
});

describe('loadTemplate — default CC errors', () => {
  it('names the CC entry and the reason it was rejected', async () => {
    writeConfig({ ccPolicy: 'optional', cc: ['ok@org.co', 'bad address@org.co'] });
    await expect(loadTemplate('c', dir)).rejects.toThrow(
      /cc\.1: email contains spaces, control or invisible characters/,
    );
  });

  it('normalizes the default CC it loads', async () => {
    writeConfig({ ccPolicy: 'optional', cc: [' coord@org.co '] });
    expect((await loadTemplate('c', dir)).cc).toEqual(['coord@org.co']);
  });
});
