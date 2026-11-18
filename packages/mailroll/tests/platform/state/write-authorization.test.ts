import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, type RecipientJournalEntry, type ResolvedTemplate, type TemplateState } from '@mailroll/core';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import { JOURNAL_HEADER_LINE } from '../../../src/platform/state/history-format';
import { listTemplate, stageList } from '../../support/staged-list';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailroll-authorization-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOT_HELD =
  /can only be written by the store that holds its lock and loaded it after taking it \(this store does not hold its lock\); nothing was written/;
const NOT_LOADED = /\(it was not loaded after the lock was taken\); nothing was written/;
const LOST = /\(its lock file no longer belongs to this run\); nothing was written/;

const intent = (email: string): RecipientJournalEntry => ({ email, intent: { at: 'T1', connectionId: 'outlook-1' } });
const snapshot = (emails: readonly string[]): TemplateState => ({
  version: 2,
  templateId: 'welcome',
  recipients: Object.fromEntries(
    emails.map((email) => [email, { status: 'sent', at: 'T0', connectionId: 'outlook-1' }]),
  ),
  updatedAt: 'T0',
});
const V2_SNAPSHOT = `${JSON.stringify(snapshot(['old@example.com']))}\n`;

function filesUnder(dir: string): Readonly<Record<string, string>> {
  if (!existsSync(dir)) {
    return {};
  }

  const files: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        files[`${relative(dir, path)}/`] = '';
        visit(path);
      } else {
        files[relative(dir, path)] = readFileSync(path, 'base64');
      }
    }
  };

  visit(dir);

  return files;
}

async function refusal(work: Promise<void>): Promise<Error> {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );

  if (!(error instanceof ConfigError)) {
    throw new Error(`expected a ConfigError, got ${String(error)}`);
  }

  return error;
}

const lists: readonly (readonly [string, () => ResolvedTemplate])[] = [
  ['a new list whose folder does not exist yet', () => listTemplate(join(root, 'campaign', '.state', 'list.json'))],
  [
    'a v2 history with a torn journal',
    () =>
      stageList(root, {
        snapshot: V2_SNAPSHOT,
        journal: `${JOURNAL_HEADER_LINE}\n{"email":"a@example.com","sta`,
      }).template,
  ],
  ['a v2 history', () => stageList(root, { snapshot: V2_SNAPSHOT }).template],
];

describe('writing a list history without the authority to write it', () => {
  it.each(lists)('refuses append and compact on %s and leaves every file as it was', async (_label, make) => {
    const template = make();
    const store = new FileStateStore();
    const before = filesUnder(root);

    await store.load(template);

    expect((await refusal(store.append(template, intent('a@example.com')))).message).toMatch(NOT_HELD);
    expect((await refusal(store.compact(template, snapshot(['a@example.com'])))).message).toMatch(NOT_HELD);
    expect(filesUnder(root)).toEqual(before);
  });

  it('refuses a store that holds the lock but has not loaded the list since taking it', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();

    await store.load(template);

    const lock = await store.lock(template);
    const before = filesUnder(root);

    expect((await refusal(store.append(template, intent('a@example.com')))).message).toMatch(NOT_LOADED);
    expect((await refusal(store.compact(template, snapshot([])))).message).toMatch(NOT_LOADED);
    expect(filesUnder(root)).toEqual(before);
    await lock.release();
  });

  it('refuses a store whose instance did not take the lock, even while another instance holds it', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const holder = new FileStateStore();
    const other = new FileStateStore();
    const lock = await holder.lock(template);

    await holder.load(template);
    await other.load(template);

    expect((await refusal(other.append(template, intent('a@example.com')))).message).toMatch(NOT_HELD);
    await lock.release();
  });

  it('writes once the same store has taken the lock and loaded the list after it', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const lock = await store.lock(template);

    await store.load(template);
    await store.append(template, intent('a@example.com'));
    await store.compact(template, await store.load(template));
    await lock.release();

    expect(Object.keys((await new FileStateStore().load(template)).recipients).sort()).toEqual([
      'a@example.com',
      'old@example.com',
    ]);
  });

  it('stops accepting writes as soon as the lock is released', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const lock = await store.lock(template);

    await store.load(template);
    await lock.release();

    const before = filesUnder(root);

    expect((await refusal(store.append(template, intent('a@example.com')))).message).toMatch(NOT_HELD);
    expect(filesUnder(root)).toEqual(before);
  });

  it('refuses writes still waiting in the queue when the lock is released, and writes nothing after the release', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const lock = await store.lock(template);

    await store.load(template);

    const settledAt: string[] = [];
    const writes = ['a@example.com', 'b@example.com', 'c@example.com'].map((email) =>
      store.append(template, intent(email)).then(
        () => {
          settledAt.push(`${email} written`);
        },
        (error: unknown) => {
          settledAt.push(`${email} refused`);
          throw error;
        },
      ),
    );
    const released = lock.release().then(() => {
      settledAt.push('released');
    });
    const outcomes = await Promise.allSettled(writes);

    await released;

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(settledAt.indexOf('released')).toBe(settledAt.length - 1);
    expect(existsSync(`${template.statePath}l`)).toBe(false);
  });

  it('never writes after the release, whatever was already queued', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const lock = await store.lock(template);

    await store.load(template);

    const first = store.append(template, intent('a@example.com'));

    await new Promise((resolve) => setImmediate(resolve));

    const later = [store.append(template, intent('b@example.com')), store.append(template, intent('c@example.com'))];
    const released = lock.release();
    const outcomes = await Promise.allSettled([first, ...later]);

    await released;

    const journal = existsSync(`${template.statePath}l`) ? readFileSync(`${template.statePath}l`, 'utf8') : '';
    const written = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;

    expect(existsSync(`${template.statePath}.lock`)).toBe(false);
    expect(outcomes.slice(1).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(journal.split('\n').filter((line) => line.includes('"intent"'))).toHaveLength(written);
  });

  it('does not accept a load made under an earlier lock after the lock is taken again', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const first = await store.lock(template);

    await store.load(template);
    await first.release();

    const second = await store.lock(template);

    expect((await refusal(store.append(template, intent('a@example.com')))).message).toMatch(NOT_LOADED);
    await second.release();
  });

  it('does not count a load that started before the lock was taken', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const loading = store.load(template);
    const lock = await store.lock(template);

    await loading;

    expect((await refusal(store.append(template, intent('a@example.com')))).message).toMatch(NOT_LOADED);
    await lock.release();
  });

  it.each([
    [
      'replaced by another owner',
      (path: string) => {
        writeFileSync(path, JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: 'T9' }));
      },
    ],
    [
      'deleted',
      (path: string) => {
        rmSync(path);
      },
    ],
  ])('refuses every later write once its lock file is %s, even if the file comes back', async (_label, lose) => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const lockPath = `${template.statePath}.lock`;
    const store = new FileStateStore();
    const lock = await store.lock(template);

    await store.load(template);
    await store.append(template, intent('a@example.com'));

    const ours = readFileSync(lockPath, 'utf8');

    lose(lockPath);

    const before = filesUnder(root);

    expect((await refusal(store.append(template, intent('b@example.com')))).message).toMatch(LOST);
    expect(filesUnder(root)).toEqual(before);

    writeFileSync(lockPath, ours);

    expect((await refusal(store.append(template, intent('c@example.com')))).message).toMatch(LOST);
    await lock.release();
  });

  it('runs appends and compactions of one list one at a time, in the order they were asked for', async () => {
    const template = stageList(root, { snapshot: V2_SNAPSHOT }).template;
    const store = new FileStateStore();
    const lock = await store.lock(template);

    await store.load(template);

    const outcomes = await Promise.allSettled([
      store.append(template, intent('a@example.com')),
      store.compact(template, snapshot(['old@example.com', 'z@example.com'])),
      store.append(template, intent('b@example.com')),
    ]);

    await lock.release();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(Object.keys((await new FileStateStore().load(template)).recipients).sort()).toEqual([
      'b@example.com',
      'old@example.com',
      'z@example.com',
    ]);
  });
});
