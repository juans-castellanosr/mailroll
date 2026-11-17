import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  emptyState,
  type RecipientJournalEntry,
  type ResolvedTemplate,
  type TemplateState,
  upgradeTemplateState,
} from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { localPidSpace } from '../../support/local-pid-space';
import { expectPrivateFile } from '../../support/private-file';
import { asWriter } from '../../support/write-access';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-state-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function template(name: string): ResolvedTemplate {
  return {
    id: 'welcome',
    campaignId: 'acme/newsletter',
    ccPolicy: 'forbidden',
    connectionIds: ['outlook-1'],
    dir: '',
    dataDir: '',
    stateDir: '',
    assetsDir: '',
    compiledHtmlPath: '',
    context: {},
    dataFile: `${name}.csv`,
    dataPath: '',
    statePath: join(dir, `${name}.state.json`),
  };
}

const journalOf = (t: ResolvedTemplate): string => `${t.statePath}l`;
const sent = (email: string): RecipientJournalEntry => ({
  email,
  status: { status: 'sent', at: 'T', connectionId: 'outlook-1' },
});
const snapshotWith = (email: string): TemplateState => ({
  version: 2,
  templateId: 'welcome',
  recipients: { [email]: { status: 'sent', at: 'T0', connectionId: 'outlook-1' } },
  updatedAt: 'T0',
});

const store = new FileStateStore();

describe('FileStateStore', () => {
  it('compacts a snapshot 0600 and loads it back', async () => {
    const t = template('roundtrip');
    const state: TemplateState = {
      version: 2,
      templateId: 'welcome',
      recipients: { 'x@y.co': { status: 'sent', at: 'T', connectionId: 'outlook-1' } },
      updatedAt: 'NOW',
    };

    await asWriter(store, t, () => store.compact(t, state));
    expectPrivateFile(t.statePath);
    expect(await store.load(t)).toEqual(state);
  });

  it('returns empty state when nothing has been persisted', async () => {
    expect(await store.load(template('absent'))).toEqual(emptyState('welcome'));
  });

  it('fails loudly on a corrupt snapshot rather than forgetting who was sent', async () => {
    const t = template('corrupt');

    writeFileSync(t.statePath, '{ not json', 'utf8');
    await expect(store.load(t)).rejects.toThrow(ConfigError);
  });

  it('replays appended sends without a snapshot (durable before compaction) and writes 0600', async () => {
    const t = template('journal-only');

    await asWriter(store, t, async () => {
      await store.append(t, sent('a@x.co'));
      await store.append(t, sent('b@x.co'));
    });

    const state = await store.load(t);

    expect(Object.keys(state.recipients)).toEqual(['a@x.co', 'b@x.co']);
    expectPrivateFile(journalOf(t));
  });

  it('layers the journal on top of an existing snapshot (resume after a crash)', async () => {
    const t = template('resume');

    await asWriter(store, t, async () => {
      await store.compact(t, snapshotWith('old@x.co'));
      await store.append(t, sent('new@x.co'));
    });

    const state = await store.load(t);

    expect(Object.keys(state.recipients).sort()).toEqual(['new@x.co', 'old@x.co']);
  });

  it('folds the journal into the snapshot on compaction and clears it', async () => {
    const t = template('fold');

    await asWriter(store, t, async () => {
      await store.append(t, sent('a@x.co'));
      await store.compact(t, upgradeTemplateState(await store.load(t)));
    });
    expect(existsSync(journalOf(t))).toBe(false);
    expect(Object.keys((await store.load(t)).recipients)).toEqual(['a@x.co']);
  });

  it('tolerates a torn final journal line (crash mid-append)', async () => {
    const t = template('torn');

    await asWriter(store, t, () => store.append(t, sent('a@x.co')));
    appendFileSync(journalOf(t), '{"email":"b@x.co","stat', 'utf8');

    const state = await store.load(t);

    expect(Object.keys(state.recipients)).toEqual(['a@x.co']);
  });

  it('fails loudly on a corrupt non-final journal line', async () => {
    const t = template('journal-corrupt');

    writeFileSync(journalOf(t), `not json\n${JSON.stringify(sent('a@x.co'))}\n`, 'utf8');
    await expect(store.load(t)).rejects.toThrow(ConfigError);
  });

  it('isolates state per CSV — a different CSV has its own independent history', async () => {
    const a = template('iso-a');
    const b = template('iso-b');

    await asWriter(store, a, () => store.compact(a, snapshotWith('a@x.co')));
    expect(Object.keys((await store.load(a)).recipients)).toEqual(['a@x.co']);
    expect(await store.load(b)).toEqual(emptyState('welcome'));
  });

  it('repairs a torn final line before appending, so the next entry is never glued to it', async () => {
    const t = template('torn-then-append');

    await asWriter(store, t, () => store.append(t, sent('a@x.co')));
    appendFileSync(journalOf(t), '{"email":"b@x.co","stat', 'utf8');

    const fresh = new FileStateStore();

    await asWriter(fresh, t, async () => {
      await fresh.append(t, sent('c@x.co'));
      await fresh.append(t, sent('d@x.co'));
    });
    expect(Object.keys((await fresh.load(t)).recipients)).toEqual(['a@x.co', 'c@x.co', 'd@x.co']);
    expect(readFileSync(journalOf(t), 'utf8').endsWith('\n')).toBe(true);
  });

  it('loads an intent without an outcome as uncertain (crash between send and record)', async () => {
    const t = template('intent-open');

    await asWriter(store, t, async () => {
      await store.append(t, { email: 'a@x.co', intent: { at: 'T1', connectionId: 'outlook-1' } });
      await store.append(t, { email: 'b@x.co', intent: { at: 'T2', connectionId: 'outlook-1' } });
      await store.append(t, sent('b@x.co'));
      await store.append(t, { email: 'c@x.co', intent: { at: 'T3', connectionId: 'outlook-1' } });
      await store.append(t, { email: 'c@x.co', released: { at: 'T4' } });
    });

    const state = await store.load(t);

    expect(state.recipients['a@x.co']).toMatchObject({ status: 'uncertain', at: 'T1' });
    expect(state.recipients['b@x.co']).toMatchObject({ status: 'sent' });
    expect(state.recipients['c@x.co']).toBeUndefined();
  });

  it('keeps a previous sent when an interrupted resend is replayed', async () => {
    const t = template('intent-over-sent');

    await asWriter(store, t, async () => {
      await store.compact(t, snapshotWith('a@x.co'));
      await store.append(t, { email: 'a@x.co', intent: { at: 'T9', connectionId: 'outlook-1' } });
    });
    expect((await store.load(t)).recipients['a@x.co']).toMatchObject({
      status: 'sent',
      at: 'T0',
      resendFailure: { outcome: 'uncertain', at: 'T9' },
    });
  });

  it('gives a list to one run at a time and recovers a lock left by a dead process', async () => {
    const t = template('locked');
    const first = await store.lock(t);

    await expect(store.lock(t)).rejects.toThrow(/in use by another run/);
    await first.release();

    const second = await store.lock(t);

    await second.release();

    writeFileSync(
      `${t.statePath}.lock`,
      JSON.stringify({
        pid: 2 ** 22 + 7,
        host: (await import('node:os')).hostname(),
        startedAt: 'T',
        pidSpace: await localPidSpace(),
      }),
    );

    const recovered = await store.lock(t);

    expect(recovered.recoveredFrom).toMatchObject({ startedAt: 'T' });
    await recovered.release();
    expect(existsSync(`${t.statePath}.lock`)).toBe(false);
  });

  it('keeps a complete last line that only lacks its newline', async () => {
    const t = template('complete-no-newline');

    await asWriter(store, t, () => store.append(t, sent('a@x.co')));
    appendFileSync(journalOf(t), JSON.stringify(sent('b@x.co')), 'utf8');

    const fresh = new FileStateStore();

    await asWriter(fresh, t, () => fresh.append(t, sent('c@x.co')));
    expect(Object.keys((await fresh.load(t)).recipients)).toEqual(['a@x.co', 'b@x.co', 'c@x.co']);
  });
});
