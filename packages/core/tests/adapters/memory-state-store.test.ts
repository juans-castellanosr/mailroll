import { describe, expect, it } from 'vitest';
import { MemoryStateStore } from '../../src/adapters/memory-state-store';
import type { ResolvedTemplate } from '../../src/domain/catalog/template';
import { ConfigError } from '../../src/domain/kernel/errors';
import { INTERRUPTED_MESSAGE, type TemplateState } from '../../src/domain/run/template-state';

const template = (statePath: string): ResolvedTemplate => ({
  id: 't',
  campaignId: 'c',
  ccPolicy: 'forbidden',
  connectionIds: ['a'],
  dir: '',
  dataDir: '',
  stateDir: '',
  assetsDir: '',
  compiledHtmlPath: '',
  context: {},
  dataFile: 'list.csv',
  dataPath: '',
  statePath,
});
const T = template('t/list.json');

describe('MemoryStateStore', () => {
  it('starts empty for an unknown list', async () => {
    const state = await new MemoryStateStore().load(T);

    expect(state).toMatchObject({ version: 2, templateId: 't', recipients: {} });
  });

  it('replays journal outcomes in order and keeps lists apart', async () => {
    const store = new MemoryStateStore();

    await store.append(T, {
      email: 'a@x.co',
      status: { status: 'failed', at: '1', connectionId: 'a', category: 'transient', message: 'x' },
    });
    await store.append(T, { email: 'a@x.co', status: { status: 'sent', at: '2', connectionId: 'a' } });

    const state = await store.load(T);
    const other = await store.load(template('t/other.json'));

    expect(state.recipients['a@x.co']).toEqual({ status: 'sent', at: '2', connectionId: 'a' });
    expect(state.updatedAt).toBe('2');
    expect(other.recipients).toEqual({});
  });

  it('loads an intent without an outcome as uncertain, and a released intent as nothing', async () => {
    const store = new MemoryStateStore();

    await store.append(T, { email: 'a@x.co', intent: { at: '1', connectionId: 'a' } });
    await store.append(T, { email: 'b@x.co', intent: { at: '1', connectionId: 'a' } });
    await store.append(T, { email: 'b@x.co', released: { at: '2' } });

    const { recipients } = await store.load(T);

    expect(recipients['a@x.co']).toEqual({
      status: 'uncertain',
      at: '1',
      connectionId: 'a',
      message: INTERRUPTED_MESSAGE,
    });
    expect(recipients['b@x.co']).toBeUndefined();
  });

  it('compaction replaces the snapshot and clears the journal', async () => {
    const store = new MemoryStateStore();

    await store.append(T, { email: 'a@x.co', intent: { at: '1', connectionId: 'a' } });

    const snapshot: TemplateState = { version: 2, templateId: 't', recipients: {}, updatedAt: '5' };

    await store.compact(T, snapshot);

    expect(await store.load(T)).toEqual(snapshot);
  });

  it('lets one run hold a list at a time', async () => {
    const store = new MemoryStateStore();
    const lock = await store.lock(T);

    await expect(store.lock(T)).rejects.toBeInstanceOf(ConfigError);
    await lock.release();
    await expect(store.lock(T)).resolves.toBeDefined();
  });
});
