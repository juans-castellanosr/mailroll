import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mailroll from 'mailroll';
import { runOutlookCli } from '../../src/cli/program';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);

      if (String(args[0]).endsWith('sent.json')) {
        return Object.assign(handle, {
          writeFile: () =>
            Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
        });
      }

      return handle;
    },
  };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-outlook-write-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content), 'utf8');
}

describe('mailroll-outlook export-sent when the output cannot be written', () => {
  it('leaves no partial file behind, so running it again works, and keeps exit code 1', async () => {
    const base = join(root, 'campaigns', 'acme', 'onboarding');
    const out = join(root, 'sent.json');
    const errors: string[] = [];

    write(join(base, 'campaign.config.json'), { displayName: 'Onboarding' });
    write(join(base, 'connections', 'outlook-1.json'), {
      id: 'outlook-1',
      kind: 'outlook',
      mailbox: 'sender@example.com',
    });

    const status = await runOutlookCli(
      [
        '-C',
        join(root, 'campaigns'),
        'export-sent',
        '-c',
        'acme/onboarding',
        '--connection',
        'outlook-1',
        '--since',
        '2026-01-15',
        '-o',
        out,
      ],
      {
        out: { info: () => undefined, error: (text) => errors.push(text) },
        env: {
          ACME_ONBOARDING__OUTLOOK_1__TENANT_ID: 'tenant',
          ACME_ONBOARDING__OUTLOOK_1__CLIENT_ID: 'client',
        },
        interactive: false,
        writeOut: () => undefined,
        loadHost: () => Promise.resolve(mailroll),
        fetchFn: () => Promise.resolve(new Response(JSON.stringify({ value: [] }), { status: 200 })),
        authFor: () => ({ getAccessToken: () => Promise.resolve('TOKEN') }),
      },
    );

    expect(status).toBe(1);
    expect(errors[0]).toMatch(new RegExp(`cannot write .*sent\\.json; nothing was kept\\n  caused by: ENOSPC`));
    expect(existsSync(out)).toBe(false);
  });
});
