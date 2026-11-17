import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmailProvider, Message } from '@mailroll/core';

const MAX_NAME_CHARS = 80;

export class PreviewEmailProvider implements EmailProvider {
  private index = 0;
  private dirReady: Promise<string | undefined> | undefined;

  constructor(private readonly outputDir: string) {}

  async send(message: Message): Promise<void> {
    await this.ensureDir();
    this.index += 1;

    const filename = `${String(this.index).padStart(4, '0')}-${fileSafeName(message.to)}.html`;

    const forComment = (value: string): string => value.replace(/[<>]/g, '');
    const ccPart =
      message.cc !== undefined && message.cc.length > 0 ? ` | cc: ${forComment(message.cc.join(', '))}` : '';
    const header = `<!-- DRY RUN preview | to: ${forComment(message.to)}${ccPart} | subject: ${forComment(message.subject)} -->\n`;

    await writeFile(join(this.outputDir, filename), header + message.html, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }

  private ensureDir(): Promise<string | undefined> {
    this.dirReady ??= mkdir(this.outputDir, { recursive: true, mode: 0o700 });

    return this.dirReady;
  }
}

function fileSafeName(address: string): string {
  const safe = address.replace(/[^a-zA-Z0-9._@-]/g, '_');

  if (safe.length <= MAX_NAME_CHARS) {
    return safe;
  }

  const digest = createHash('sha256').update(address).digest('hex').slice(0, 10);

  return `${safe.slice(0, MAX_NAME_CHARS)}~${digest}`;
}
