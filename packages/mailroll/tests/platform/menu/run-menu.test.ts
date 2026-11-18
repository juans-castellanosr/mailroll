import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, type Logger, type SendSelection, type Template, type TemplateTarget } from '@mailroll/core';
import { runSelection } from '../../../src/platform/composition/build-runner';
import { createTestSender } from '../../support/test-sender';
import { loadTemplatePlugin } from '../../../src/platform/composition/load-template-plugin';
import { resolveTemplate } from '../../../src/platform/composition/resolve-template';
import { type MenuOutcome, runMenu } from '../../../src/platform/menu/run-menu';
import { FileStateStore } from '../../../src/platform/state/file-state-store';
import {
  answerConfirm,
  choose,
  inspect,
  keepTicks,
  ScriptedPrompts,
  stubCcPrompts,
  tick,
  type Answer,
  type PromptCall,
  type as typeText,
} from './scripted-prompts';

const PLUGIN = resolve(import.meta.dirname, '../../fixtures/plugins/flagged-rows-plugin.ts');

type Row = string | { readonly rejected: string };

interface TemplateFixture {
  readonly id: string;
  readonly ccPolicy: 'forbidden' | 'required' | 'optional';
  readonly cc?: readonly string[];
  readonly connectionIds?: readonly string[];
  readonly csvs: Readonly<Record<string, readonly Row[]>>;
  readonly corruptState?: string;
  readonly history?: Readonly<Record<string, Readonly<Record<string, 'sent' | 'failed' | 'uncertain'>>>>;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ee-menu-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function scaffold(templates: readonly TemplateFixture[], connections: readonly string[] = ['outlook-1']): void {
  const base = join(root, 'acme', 'newsletter');

  write(join(base, 'campaign.config.json'), JSON.stringify({ displayName: 'Newsletter' }));
  for (const id of connections) {
    write(join(base, 'connections', `${id}.json`), JSON.stringify({ id, kind: 'outlook', mailbox: `${id}@org.co` }));
  }

  for (const t of templates) {
    const dir = join(base, 'templates', t.id);

    write(
      join(dir, 'config', 'template.config.json'),
      JSON.stringify({
        ccPolicy: t.ccPolicy,
        connectionIds: t.connectionIds ?? connections,
        context: {},
        ...(t.cc !== undefined ? { cc: t.cc } : {}),
      }),
    );
    write(join(dir, 'code', 'plugin.ts'), `export { default } from ${JSON.stringify(PLUGIN)};\n`);
    for (const [file, rows] of Object.entries(t.csvs)) {
      const lines = rows.map((row) => (typeof row === 'string' ? `${row},yes` : `${row.rejected},no`));

      write(join(dir, 'data', file), ['email,ok', ...lines].join('\n'));
    }

    if (t.corruptState !== undefined) {
      write(statePath(t, t.corruptState), '{ not json');
    }

    for (const [file, statuses] of Object.entries(t.history ?? {})) {
      const recipients = Object.fromEntries(
        Object.entries(statuses).map(([email, status]) => [
          email,
          status === 'sent'
            ? { status, at: '2026-10-01T00:00:00.000Z', connectionId: 'outlook-1' }
            : status === 'uncertain'
              ? { status, at: '2026-10-01T00:00:00.000Z', connectionId: 'outlook-1', message: 'timeout' }
              : {
                  status,
                  at: '2026-10-01T00:00:00.000Z',
                  connectionId: 'outlook-1',
                  category: 'transient',
                  message: 'x',
                },
        ]),
      );

      write(
        statePath(t, file),
        JSON.stringify({ version: 2, templateId: t.id, recipients, updatedAt: '2026-10-01T00:00:00.000Z' }),
      );
    }
  }
}

function statePath(t: TemplateFixture, file: string): string {
  const dir = join(root, 'acme', 'newsletter', 'templates', t.id);
  const template: Template = {
    id: t.id,
    campaignId: 'acme/newsletter',
    connectionIds: [],
    ccPolicy: t.ccPolicy,
    dir,
    dataDir: join(dir, 'data'),
    stateDir: join(dir, '.state'),
    assetsDir: join(dir, 'view', 'assets'),
    compiledHtmlPath: join(dir, 'view', 'compiled.html'),
    context: {},
  };

  return resolveTemplate(template, file).statePath;
}

const NEWS: TemplateFixture = {
  id: 'news',
  ccPolicy: 'required',
  cc: ['coord@org.co'],
  csvs: { 'news.csv': ['a@x.co', 'b@x.co', 'c@x.co'] },
};
const CREDS: TemplateFixture = { id: 'creds', ccPolicy: 'forbidden', csvs: { 'creds.csv': ['z@x.co'] } };

async function run(
  script: Answer[],
  options: { env?: NodeJS.ProcessEnv; cc?: ReturnType<typeof stubCcPrompts>; random?: () => number } = {},
): Promise<{ outcome: MenuOutcome; prompts: ScriptedPrompts }> {
  const prompts = new ScriptedPrompts(script);
  const outcome = await runMenu({
    campaignsRoot: root,
    prompts,
    ccPrompts: options.cc ?? stubCcPrompts([], ''),
    store: new FileStateStore(),
    loadPlugin: loadTemplatePlugin,
    env: options.env ?? {},
    random: options.random ?? (() => 0),
  });

  expect(prompts.remaining).toBe(0);

  return { outcome, prompts };
}

function selectionOf(outcome: MenuOutcome): SendSelection {
  if (outcome.kind !== 'run') {
    throw new Error('expected a run outcome');
  }

  return outcome.selection;
}

function target(selection: SendSelection, templateId: string): TemplateTarget | undefined {
  return selection.targets.find((t) => t.templateId === templateId);
}

const choiceNames = (call: PromptCall): string[] =>
  call.kind === 'select' || call.kind === 'checkbox' ? call.choices.map((c) => c.name) : [];

describe('runMenu — catalog steps', () => {
  it('chooses the only campaign, template, CSV and connection by itself and says so', async () => {
    scaffold([NEWS]);

    const { outcome, prompts } = await run([choose('Live'), choose('Send 3'), answerConfirm(true)]);

    expect(prompts.printed).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Campaign: Newsletter (acme/newsletter) — the only campaign available'),
        expect.stringContaining('Templates: news — the only template available'),
        expect.stringContaining('Connection: outlook-1 (outlook-1@org.co) — the only connection'),
      ]),
    );
    expect(selectionOf(outcome).connectionIds).toEqual(['outlook-1']);
  });

  it('offers several templates in a checkbox annotated with each list state', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'sent' } } }, CREDS]);

    const { outcome } = await run([
      inspect((call) => {
        expect(choiceNames(call)).toEqual([
          'creds — 1 in list · sent 0 · failed 0 · pending 1',
          'news — 3 in list · sent 1 · failed 0 · pending 2',
        ]);
      }, tick('news')),
      choose('QA'),
      choose('Render'),
    ]);

    expect(selectionOf(outcome).targets.map((t) => t.templateId)).toEqual(['news']);
  });

  it('asks which CSV when a template has several, one target per chosen CSV', async () => {
    scaffold([{ ...NEWS, csvs: { 'one.csv': ['a@x.co'], 'two.csv': ['b@x.co'] } }]);

    const { outcome } = await run([tick('one.csv', 'two.csv'), choose('QA'), choose('Render')]);

    expect(selectionOf(outcome).targets.map((t) => t.dataFile)).toEqual(['one.csv', 'two.csv']);
  });

  it('offers only the connections shared by every selected template, as a checkbox', async () => {
    scaffold(
      [
        { ...NEWS, connectionIds: ['outlook-1', 'outlook-2', 'outlook-3'] },
        { ...CREDS, connectionIds: ['outlook-1', 'outlook-2'] },
      ],
      ['outlook-1', 'outlook-2', 'outlook-3'],
    );

    const { outcome } = await run([
      tick('news', 'creds'),
      inspect(
        (call) => {
          expect(choiceNames(call)).toEqual(['outlook-1 (outlook-1@org.co)', 'outlook-2 (outlook-2@org.co)']);
        },
        tick('outlook-1', 'outlook-2'),
      ),
      choose('QA'),
      choose('Render'),
    ]);

    expect(selectionOf(outcome).connectionIds).toEqual(['outlook-1', 'outlook-2']);
  });

  it('stops with a clear error when the selected templates share no connection', async () => {
    scaffold(
      [
        { ...NEWS, connectionIds: ['outlook-1'] },
        { ...CREDS, connectionIds: ['outlook-2'] },
      ],
      ['outlook-1', 'outlook-2'],
    );
    const prompts = new ScriptedPrompts([tick('news', 'creds')]);

    await expect(
      runMenu({
        campaignsRoot: root,
        prompts,
        ccPrompts: stubCcPrompts([], ''),
        store: new FileStateStore(),
        loadPlugin: loadTemplatePlugin,
        env: {},
        random: () => 0,
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('runMenu — Live', () => {
  it('sends everyone with the template CC by default, after a confirmation that defaults to No', async () => {
    scaffold([NEWS, CREDS]);

    const { outcome, prompts } = await run([
      tick('news', 'creds'),
      choose('Live'),
      inspect((call) => {
        expect(choiceNames(call)).not.toContain('Change policy (what to do with previous sends)');
      }, choose('Send 4')),
      inspect((call) => {
        expect(call).toMatchObject({ kind: 'confirm', defaultValue: false });
      }, answerConfirm(true)),
    ]);

    const selection = selectionOf(outcome);

    expect(selection.mode).toEqual({ kind: 'live' });
    expect(selection.policy).toEqual({ kind: 'pending' });

    const { dataFingerprint: newsPrint, ...news } = target(selection, 'news') ?? { templateId: '' };
    const { dataFingerprint: credsPrint, ...creds } = target(selection, 'creds') ?? { templateId: '' };

    expect(news).toEqual({ templateId: 'news', dataFile: 'news.csv', cc: ['coord@org.co'] });
    expect(creds).toEqual({ templateId: 'creds', dataFile: 'creds.csv' });
    expect([newsPrint, credsPrint]).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(prompts.printed.join('\n')).toContain('First send — no list has history');
  });

  it('blocks the send while a CC-required template has no CC, until one is set', async () => {
    const { cc: _defaultCc, ...newsWithoutCc } = NEWS;

    scaffold([newsWithoutCc]);
    const cc = stubCcPrompts([], 'new@org.co');
    const { outcome } = await run(
      [
        choose('Live'),
        inspect((call) => {
          const send = call.kind === 'select' ? call.choices.find((c) => c.value === 'go') : undefined;

          expect(send?.disabled).toContain('a CC is required by news');
        }, choose('Change CC')),
        choose('Send 3'),
        answerConfirm(true),
      ],
      { cc, env: { CC_RECIPIENT: 'saved@org.co' } },
    );

    expect(cc.seen).toEqual([['saved@org.co'], []]);
    expect(target(selectionOf(outcome), 'news')?.cc).toEqual(['new@org.co']);
  });

  it('edits the CC starting from the template default, pre-ticked', async () => {
    scaffold([NEWS]);
    const cc = stubCcPrompts(['coord@org.co'], 'extra@org.co');
    const { outcome } = await run([choose('Live'), choose('Change CC'), choose('Send'), answerConfirm(true)], {
      cc,
      env: { CC_RECIPIENT: 'saved@org.co' },
    });

    expect(cc.seen).toEqual([['coord@org.co', 'saved@org.co'], ['coord@org.co']]);
    expect(target(selectionOf(outcome), 'news')?.cc).toEqual(['coord@org.co', 'extra@org.co']);
  });

  it('with history, resumes pending by default and offers the policy choice', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'sent', 'b@x.co': 'failed' } } }]);

    const { outcome, prompts } = await run([
      choose('Live'),
      choose('Change policy'),
      inspect((call) => {
        expect(call.kind === 'select' && call.defaultValue).toBe('pending');
      }, choose('Retry failed only')),
      choose('Send 1'),
      answerConfirm(true),
    ]);

    expect(selectionOf(outcome).policy).toEqual({ kind: 'failed-only' });
    expect(prompts.printed.join('\n')).toContain('Pending only');
  });

  it('turns a hand-picked recipient set into a per-list subset', async () => {
    scaffold([NEWS]);

    const { outcome } = await run([
      choose('Live'),
      choose('Choose recipients'),
      inspect(
        (call) => {
          expect(call.kind === 'checkbox' && call.choices.every((c) => c.checked === true)).toBe(true);
        },
        tick('a@x.co', 'c@x.co'),
      ),
      choose('Send 2'),
      answerConfirm(true),
    ]);

    expect(target(selectionOf(outcome), 'news')?.policy).toEqual({ kind: 'subset', recipients: ['a@x.co', 'c@x.co'] });
  });

  it('keeps the policy when the hand-picked set equals what the policy selects', async () => {
    scaffold([NEWS]);

    const { outcome } = await run([
      choose('Live'),
      choose('Choose recipients'),
      keepTicks,
      choose('Send 3'),
      answerConfirm(true),
    ]);

    expect(target(selectionOf(outcome), 'news')?.policy).toBeUndefined();
  });

  it('declining the confirmation returns to the panel; Cancel sends nothing', async () => {
    scaffold([NEWS]);

    const { outcome } = await run([choose('Live'), choose('Send'), answerConfirm(false), choose('Cancel')]);

    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  it('disables the send when the settings select nobody', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'sent', 'b@x.co': 'sent', 'c@x.co': 'sent' } } }]);

    const { outcome } = await run([
      choose('Live'),
      inspect((call) => {
        const send = call.kind === 'select' ? call.choices.find((c) => c.value === 'go') : undefined;

        expect(send?.disabled).toBe('nothing to send with these settings');
      }, choose('Cancel')),
    ]);

    expect(outcome.kind).toBe('cancelled');
  });
});

describe('runMenu — QA', () => {
  it('renders previews of exactly what Live would send, with no confirmation', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'sent' } } }]);

    const { outcome } = await run([choose('QA'), choose('Render 2')]);

    expect(outcome).toMatchObject({ kind: 'run', writePreviews: true });
    expect(selectionOf(outcome).mode).toEqual({ kind: 'dry-run' });
  });
});

describe('runMenu — Stage/UAT', () => {
  it('shows the test inbox and CC and sends one random recipient per list to the test inbox', async () => {
    scaffold([NEWS, CREDS]);

    const { outcome, prompts } = await run([tick('news', 'creds'), choose('Stage'), choose('Send 2 test')], {
      env: { TEST_RECIPIENT: 'qa@org.co' },
      random: () => 0.5,
    });
    const selection = selectionOf(outcome);

    expect(selection.mode).toEqual({ kind: 'test', testRecipient: 'qa@org.co' });

    const { dataFingerprint, ...news } = target(selection, 'news') ?? { templateId: '' };

    expect(news).toEqual({
      templateId: 'news',
      dataFile: 'news.csv',
      cc: ['coord@org.co'],
      policy: { kind: 'subset', recipients: ['b@x.co'] },
    });
    expect(dataFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(target(selection, 'creds')?.policy).toEqual({ kind: 'subset', recipients: ['z@x.co'] });

    const panel = prompts.printed.join('\n');

    expect(panel).toContain('Test inbox   qa@org.co');
    expect(panel).toContain('coord@org.co');
    expect(panel).toContain('not allowed');
  });

  it('lets the operator edit the test inbox and the CC', async () => {
    scaffold([NEWS]);
    const cc = stubCcPrompts([], 'other@org.co');
    const { outcome } = await run(
      [
        choose('Stage'),
        choose('Edit test inbox'),
        inspect((call) => {
          expect(call.kind === 'input' && call.options.default).toBe('qa@org.co');
        }, typeText('me@org.co')),
        choose('Edit CC'),
        choose('Send 1 test'),
      ],
      { env: { TEST_RECIPIENT: 'qa@org.co' }, cc },
    );
    const selection = selectionOf(outcome);

    expect(selection.mode).toEqual({ kind: 'test', testRecipient: 'me@org.co' });
    expect(target(selection, 'news')?.cc).toEqual(['other@org.co']);
  });

  it('asks for the test inbox when none is configured', async () => {
    scaffold([NEWS]);

    const { outcome } = await run([choose('Stage'), typeText('me@org.co'), choose('Send 1 test')]);

    expect(selectionOf(outcome).mode).toEqual({ kind: 'test', testRecipient: 'me@org.co' });
  });

  it('can render a chosen recipient, or the whole list, into the test inbox', async () => {
    scaffold([NEWS]);

    const chosen = await run(
      [choose('Stage'), choose('Change scope'), choose('chosen by you'), choose('c@x.co'), choose('Send 1 test')],
      { env: { TEST_RECIPIENT: 'qa@org.co' } },
    );

    expect(target(selectionOf(chosen.outcome), 'news')?.policy).toEqual({ kind: 'subset', recipients: ['c@x.co'] });

    const all = await run([choose('Stage'), choose('Change scope'), choose('Every recipient'), choose('Send 3 test')], {
      env: { TEST_RECIPIENT: 'qa@org.co' },
    });

    expect(target(selectionOf(all.outcome), 'news')?.policy).toEqual({ kind: 'force-all' });
  });
});

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('runMenu — agrees with the engine', () => {
  it('counts only the rows the template validator accepts, exactly as the run sends them', async () => {
    scaffold([{ ...NEWS, csvs: { 'news.csv': ['a@x.co', { rejected: 'b@x.co' }, 'c@x.co'] } }, CREDS]);

    const { outcome } = await run([
      inspect((call) => {
        expect(choiceNames(call)).toContain('news — 2 in list · sent 0 · failed 0 · pending 2 · 1 row(s) rejected');
      }, tick('news')),
      choose('QA'),
      choose('Render 2'),
    ]);

    const results = await runSelection(selectionOf(outcome), {
      campaignsRoot: root,
      logger: silent,
      previewDir: join(root, 'previews'),
      integrations: [createTestSender({ id: 'outlook' })],
    });

    expect(results.map((r) => [r.report.sent, r.report.skipped])).toEqual([[2, 1]]);
  });

  it('never draws a rejected row as the Stage sample', async () => {
    scaffold([{ ...NEWS, csvs: { 'news.csv': [{ rejected: 'a@x.co' }, 'b@x.co'] } }]);

    const { outcome } = await run([choose('Stage'), choose('Send 1 test')], {
      env: { TEST_RECIPIENT: 'qa@org.co' },
      random: () => 0,
    });

    expect(target(selectionOf(outcome), 'news')?.policy).toEqual({ kind: 'subset', recipients: ['b@x.co'] });
  });

  it('shows a template whose state cannot be read as unavailable instead of failing', async () => {
    scaffold([{ ...NEWS, corruptState: 'news.csv' }, CREDS]);

    const { outcome } = await run([
      inspect((call) => {
        const broken = call.kind === 'checkbox' ? call.choices.find((c) => c.name.startsWith('news')) : undefined;

        expect(broken?.disabled).toMatch(/^cannot be read: /);
      }, tick('creds')),
      choose('QA'),
      choose('Render'),
    ]);

    expect(selectionOf(outcome).targets.map((t) => t.templateId)).toEqual(['creds']);
  });
});

describe('runMenu — CC is per template', () => {
  const OTHER: TemplateFixture = {
    id: 'other',
    ccPolicy: 'required',
    cc: ['boss@org.co'],
    csvs: { 'other.csv': ['o@x.co'] },
  };

  it('edits the CC of the chosen list only, starting from its own CC', async () => {
    scaffold([NEWS, OTHER]);
    const cc = stubCcPrompts(['boss@org.co'], 'deputy@org.co');
    const { outcome } = await run(
      [
        tick('news', 'other'),
        choose('Live'),
        choose('Change CC'),
        choose('other · other.csv'),
        choose('Send'),
        answerConfirm(true),
      ],
      { cc },
    );

    expect(cc.seen).toEqual([['boss@org.co'], ['boss@org.co']]);

    const selection = selectionOf(outcome);

    expect(target(selection, 'news')?.cc).toEqual(['coord@org.co']);
    expect(target(selection, 'other')?.cc).toEqual(['boss@org.co', 'deputy@org.co']);
  });

  it('never merges different CCs when setting one CC for all lists', async () => {
    scaffold([NEWS, OTHER]);
    const cc = stubCcPrompts([], 'one@org.co');
    const { outcome } = await run(
      [
        tick('news', 'other'),
        choose('Live'),
        choose('Change CC'),
        choose('All of the lists'),
        choose('Send'),
        answerConfirm(true),
      ],
      { cc },
    );

    expect(cc.seen).toEqual([]);

    const selection = selectionOf(outcome);

    expect(target(selection, 'news')?.cc).toEqual(['one@org.co']);
    expect(target(selection, 'other')?.cc).toEqual(['one@org.co']);
  });

  it('warns in Stage that the CC receives a copy of every test email', async () => {
    scaffold([NEWS]);

    const { prompts } = await run([choose('Stage'), choose('Send 1 test')], { env: { TEST_RECIPIENT: 'qa@org.co' } });

    expect(prompts.printed.join('\n')).toContain('DOES receive a copy');
  });

  it('reports an invalid TEST_RECIPIENT instead of silently ignoring it', async () => {
    scaffold([NEWS]);

    const { prompts, outcome } = await run([choose('Stage'), typeText('me@org.co'), choose('Send 1 test')], {
      env: { TEST_RECIPIENT: 'not-an-address' },
    });

    expect(prompts.printed.join('\n')).toContain('TEST_RECIPIENT "not-an-address" is not a valid address');
    expect(selectionOf(outcome).mode).toEqual({ kind: 'test', testRecipient: 'me@org.co' });
  });
});

describe('runMenu — hand-picked recipients and history', () => {
  it('states how many hand-picked recipients were already sent and will receive it again', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'sent' } } }]);

    const { prompts } = await run([
      choose('Live'),
      choose('Choose recipients'),
      tick('a@x.co', 'b@x.co'),
      choose('Send 2'),
      inspect((call) => {
        expect(call.message).toContain('1 of them were already sent and will receive it AGAIN');
        expect(call.message).toContain('CC: coord@org.co');
      }, answerConfirm(false)),
      choose('Cancel'),
    ]);

    expect(prompts.printed.join('\n')).toContain('2 (chosen, 1 already sent — will be re-sent)');
  });
});

describe('runMenu — evidence from a v2 history', () => {
  it('says how many of the already-sent recipients had a rejected CC before re-sending them', async () => {
    scaffold([NEWS]);
    write(
      statePath(NEWS, 'news.csv'),
      JSON.stringify({
        version: 2,
        templateId: 'news',
        recipients: {
          'a@x.co': {
            status: 'sent',
            at: '2026-10-01T00:00:00.000Z',
            connectionId: 'outlook-1',
            attemptId: 'A',
            cc: { rejected: ['coord@org.co'], required: true },
          },
        },
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    );

    const { prompts } = await run([
      choose('Live'),
      choose('Choose recipients'),
      tick('a@x.co', 'b@x.co'),
      choose('Send 2'),
      inspect(() => undefined, answerConfirm(false)),
      choose('Cancel'),
    ]);

    expect(prompts.printed.join('\n')).toContain(
      '2 (chosen, 1 already sent — will be re-sent, 1 of them with a rejected CC)',
    );
  });
});

describe('runMenu — warnings and unavailable templates', () => {
  it('counts re-sends under "Force from scratch" in the Live confirmation', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'sent', 'b@x.co': 'sent' } } }]);
    await run([
      choose('Live'),
      choose('Change policy'),
      choose('Force from scratch'),
      choose('Send 3'),
      inspect((call) => {
        expect(call.message).toContain('2 of them were already sent and will receive it AGAIN');
      }, answerConfirm(false)),
      choose('Cancel'),
    ]);
  });

  it('says there is no CC when no selected template accepts one', async () => {
    scaffold([CREDS]);
    await run([
      choose('Live'),
      choose('Send 1'),
      inspect((call) => {
        expect(call.message).toContain('(CC: none)');
      }, answerConfirm(false)),
      choose('Cancel'),
    ]);
  });

  it('disables a template whose CSV names would share one send history', async () => {
    scaffold([{ ...NEWS, csvs: { 'grupo-1.csv': ['a@x.co'], 'grupo 1.csv': ['b@x.co'] } }, CREDS]);
    await run([
      inspect((call) => {
        const clash = call.kind === 'checkbox' ? call.choices.find((c) => c.name.startsWith('news')) : undefined;

        expect(clash?.disabled).toContain('map to the same send-state file');
      }, tick('creds')),
      choose('QA'),
      choose('Render'),
    ]);
  });

  it('names every template and its reason when none can be used', async () => {
    scaffold([
      { ...NEWS, corruptState: 'news.csv' },
      { ...CREDS, csvs: {} },
    ]);
    await expect(
      runMenu({
        campaignsRoot: root,
        prompts: new ScriptedPrompts([]),
        ccPrompts: stubCcPrompts([], ''),
        store: new FileStateStore(),
        loadPlugin: loadTemplatePlugin,
        env: {},
        random: () => 0,
      }),
    ).rejects.toThrow(/creds: no CSV in data\/.*news: cannot be read|news: cannot be read.*creds: no CSV/);
  });

  it('warns that uncertain recipients would be resent and shows them as such', async () => {
    scaffold([{ ...NEWS, history: { 'news.csv': { 'a@x.co': 'uncertain' } } }]);

    const { prompts } = await run([
      choose('Live'),
      inspect((call) => {
        expect(choiceNames(call)[0]).toContain('Send 2');
      }, choose('Change policy')),
      choose('Force from scratch'),
      choose('Send 3'),
      inspect((call) => {
        expect(call.message).toContain('1 of them are UNCERTAIN (they may already have it)');
      }, answerConfirm(false)),
      choose('Cancel'),
    ]);

    expect(prompts.printed.join('\n')).toContain('1 uncertain — may already have it');
  });
});
