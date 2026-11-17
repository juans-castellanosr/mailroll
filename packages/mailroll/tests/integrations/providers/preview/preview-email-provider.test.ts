import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '@mailroll/core';
import { PreviewEmailProvider } from '../../../../src/integrations/providers/preview/preview-email-provider';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-preview-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PreviewEmailProvider', () => {
  it('numbers every preview once, so addresses that look alike never overwrite each other', async () => {
    const writer = new PreviewEmailProvider(dir);

    await writer.send({ to: addr('a+b@x.co'), subject: 's', html: 'PLUS' });
    await writer.send({ to: addr('a_b@x.co'), subject: 's', html: 'UNDERSCORE' });
    expect(readdirSync(dir).sort()).toEqual(['0001-a_b@x.co.html', '0002-a_b@x.co.html']);
  });

  it('keeps the file name short for a very long address, with a hash to tell them apart', async () => {
    const writer = new PreviewEmailProvider(dir);
    const local = 'x'.repeat(64);
    const domain = `${'d'.repeat(60)}.${'e'.repeat(60)}.${'f'.repeat(60)}.com`;

    await writer.send({ to: addr(`${local}@${domain}`), subject: 's', html: 'LONG' });

    const [name] = readdirSync(dir);

    expect(name?.length).toBeLessThan(120);
    expect(name).toMatch(/^0001-x{64}@d{15}~[0-9a-f]{10}\.html$/);
  });
});
