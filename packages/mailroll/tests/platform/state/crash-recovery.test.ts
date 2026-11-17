import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DataSource,
  type EmailProvider,
  type Message,
  parseEmailAddress,
  type Recipient,
  type RecipientJournalEntry,
  type ResolvedTemplate,
  runTemplate,
  type SourceRecord,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { withLock } from '../../support/write-access';

class Source implements DataSource {
  constructor(private readonly emails: readonly string[]) {}
  async *read(): AsyncIterable<SourceRecord> {
    for (const email of this.emails) {
      await Promise.resolve();
      yield { email };
    }
  }
}

class Recorder implements EmailProvider {
  readonly sent: string[] = [];
  send(message: Message): Promise<void> {
    this.sent.push(message.to);

    return Promise.resolve();
  }
}

class DyingStore extends FileStateStore {
  private writes = 0;
  constructor(private readonly dieAt: number) {
    super();
  }

  override async append(template: ResolvedTemplate, entry: RecipientJournalEntry): Promise<void> {
    this.writes += 1;
    if (this.writes === this.dieAt) {
      throw new Error('process killed');
    }

    await super.append(template, entry);
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-crash-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function template(): ResolvedTemplate {
  return {
    id: 't',
    campaignId: 'c',
    ccPolicy: 'optional',
    connectionIds: ['x'],
    dir,
    dataDir: dir,
    stateDir: dir,
    assetsDir: dir,
    compiledHtmlPath: '',
    context: {},
    dataFile: 'list.csv',
    dataPath: '',
    statePath: join(dir, 'list.json'),
  };
}

async function run(store: FileStateStore, provider: Recorder, emails: readonly string[]) {
  return withLock(store, template(), () => runList(store, provider, emails));
}

function runList(store: FileStateStore, provider: Recorder, emails: readonly string[]) {
  return runTemplate<Recipient>({
    template: template(),
    source: new Source(emails),
    validator: {
      validate: (record) => {
        const email = parseEmailAddress(record['email'] ?? '');

        return email.ok ? { ok: true, value: { email: email.value } } : { ok: false, reasons: email.reasons };
      },
    },
    renderer: { render: () => ({ subject: 's', html: '<p>x</p>' }) },
    providers: new Map([['x', provider]]),
    connectionIds: ['x'],
    policy: { kind: 'pending' },
    mode: { kind: 'live' },
    delayBetweenSendsMs: 0,
    stateStore: store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleeper: { sleep: () => Promise.resolve() },
    now: () => '2026-10-28T00:00:00.000Z',
  });
}

describe('crash between a send and its record', () => {
  it('marks the ambiguous recipient uncertain and never re-sends it automatically', async () => {
    const emails = ['a@x.co', 'b@x.co', 'c@x.co'];
    const first = new Recorder();

    await expect(run(new DyingStore(4), first, emails)).rejects.toThrow(/could not record send state/);
    expect(first.sent).toEqual(['a@x.co', 'b@x.co']);
    expect(existsSync(join(dir, 'list.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'list.json'), 'utf8'))).toMatchObject({ version: 2, recipients: {} });

    const second = new Recorder();
    const report = await run(new FileStateStore(), second, emails);

    expect(second.sent).toEqual(['c@x.co']);
    expect(report).toMatchObject({ sent: 1, skipped: 2 });

    const state = await new FileStateStore().load(template());

    expect(state.recipients['a@x.co']?.status).toBe('sent');
    expect(state.recipients['b@x.co']?.status).toBe('uncertain');
    expect(state.recipients['c@x.co']?.status).toBe('sent');
    expect([...first.sent, ...second.sent].filter((e, i, all) => all.indexOf(e) !== i)).toEqual([]);
  });
});
