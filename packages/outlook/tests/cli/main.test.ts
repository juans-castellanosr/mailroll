import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE = resolve(import.meta.dirname, '../..');
const MAIN = join(PACKAGE, 'src', 'cli', 'main.ts');
const TSX = pathToFileURL(createRequire(join(PACKAGE, 'package.json')).resolve('tsx')).href;
const ESCAPE = String.fromCharCode(27);

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mailroll-outlook-main-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('the mailroll-outlook binary', { timeout: 60_000 }, () => {
  it('reads the connection secrets from .env, accepts -q, and prints no color with --no-color', () => {
    write(join(cwd, 'campaigns', 'acme', 'onboarding', 'campaign.config.json'), JSON.stringify({ displayName: 'O' }));
    write(
      join(cwd, 'campaigns', 'acme', 'onboarding', 'connections', 'outlook-1.json'),
      JSON.stringify({ id: 'outlook-1', kind: 'outlook', mailbox: 'sender@example.com' }),
    );
    write(
      join(cwd, '.env'),
      [
        'ACME_ONBOARDING__OUTLOOK_1__TENANT_ID=00000000-0000-0000-0000-000000000001',
        'ACME_ONBOARDING__OUTLOOK_1__CLIENT_ID=00000000-0000-0000-0000-000000000002',
        `TOKEN_CACHE_PATH=${join(cwd, 'tokens')}`,
      ].join('\n'),
    );

    const run = spawnSync(
      process.execPath,
      [
        '--import',
        TSX,
        MAIN,
        '-q',
        '--no-color',
        'export-sent',
        '-c',
        'acme/onboarding',
        '--connection',
        'outlook-1',
        '--since',
        '2026-01-15',
        '-o',
        'sent.json',
      ],
      {
        cwd,
        encoding: 'utf8',
        input: '',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: cwd,
          FORCE_COLOR: '1',
          TSX_TSCONFIG_PATH: join(PACKAGE, 'tsconfig.json'),
        },
      },
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('no saved sign-in for sender@example.com');
    expect(run.stderr).not.toContain('missing environment secret');
    expect(run.stderr).not.toContain(ESCAPE);
    expect(existsSync(join(cwd, 'sent.json'))).toBe(false);
  });
});
