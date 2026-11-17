import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTEGRATION_KIND,
  type IntegrationDescriptor,
  type Message,
  SENDER_CONTRACT,
  type SendOutcome,
  valid,
} from '@mailroll/core';
import { createOutput } from '../../../src/platform/cli/output';
import { runCli } from '../../../src/platform/cli/program';
import { connectionEnvKey } from '../../../src/platform/config/resolve-connection-secrets';
import { dirContents } from '../../support/history-dir';
import { fixture } from '../../support/state-v1-fixtures';

const CAMPAIGNS = resolve(import.meta.dirname, '../../fixtures/campaigns');
const SEND = ['send', '-c', 'acme/onboarding', '-t', 'welcome', '--connection', 'outlook-1'];
const CC = 'records@example.net,audit@example.net';
const ENV = { [connectionEnvKey('acme/onboarding', 'outlook-1', 'TOKEN')]: 'secret' };

const ANY_TEXT: unknown = expect.any(String);
const QUEUE_NOTE: unknown = expect.stringContaining(
  'the provider accepted the message for ada@example.com, so it is not queued again',
);

const TEST_NOTE: unknown = expect.stringMatching(
  /^required CC rejected on the test send to me@example\.com for \S+: records@example\.net; nothing was recorded$/,
);

type Script = (message: Message) => SendOutcome;

let cwd: string;
let campaigns: string;
let calls: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mailroll-evidence-'));
  campaigns = join(cwd, 'campaigns');
  cpSync(CAMPAIGNS, campaigns, { recursive: true });
  calls = [];
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function perRecipientSender(script: Script): IntegrationDescriptor<Readonly<Record<string, never>>> {
  return {
    kind: INTEGRATION_KIND,
    id: 'outlook',
    version: '1.0.0',
    configuration: { secrets: [{ name: 'TOKEN', required: true, sensitive: true }], validateSettings: () => valid({}) },
    roles: {
      sender: {
        contract: SENDER_CONTRACT,
        capabilities: {
          cc: true,
          replyTo: true,
          inlineAttachments: true,
          sentCopy: 'never',
          recipientAcceptance: 'per-recipient',
        },
        prepare: () =>
          Promise.resolve({
            send: (message: Message) => {
              calls.push(message.to);

              return Promise.resolve(script(message));
            },
            close: () => Promise.resolve(),
          }),
      },
    },
  };
}

function useCcPolicy(policy: 'optional' | 'required'): void {
  const path = join(campaigns, 'acme/onboarding/templates/welcome/config/template.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

  writeFileSync(path, JSON.stringify({ ...config, ccPolicy: policy }));
}

function collector(append: (text: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      append(String(chunk));
      done();
    },
  });
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function mailroll(
  args: readonly string[],
  script: Script = () => ({ outcome: 'accepted', ccRejected: [] }),
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const logs = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);

    return true;
  });

  try {
    const status = await runCli(['-C', campaigns, '--no-color', ...args], {
      out: createOutput({
        stdout: collector((text) => (stdout += text)),
        stderr: collector((text) => (stderr += text)),
      }),
      env: ENV,
      interactive: false,
      cwd,
      loadIntegrations: () => Promise.resolve([perRecipientSender(script)]),
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
    });

    return { status, stdout, stderr };
  } finally {
    logs.mockRestore();
  }
}

const live = (...extra: string[]) => [...SEND, '-m', 'live', '--confirm', '--cc', CC, ...extra];

interface SummaryList {
  readonly statePath: string;
  readonly counts: Record<string, number>;
  readonly attention: readonly Record<string, unknown>[];
  readonly ccRejected: readonly Record<string, unknown>[];
  readonly history: Record<string, unknown>;
}

function listOf(run: Run): SummaryList {
  const summary = JSON.parse(run.stdout) as { lists: SummaryList[] };
  const [list] = summary.lists;

  if (list === undefined) {
    throw new Error(`no list in the summary: ${run.stdout}`);
  }

  return list;
}

const rejectFor =
  (who: string, rejected: readonly string[]): Script =>
  (message) => ({ outcome: 'accepted', ccRejected: message.to === who ? rejected : [] });

describe('rejected CC in the run summary', () => {
  it('reports an optional rejected CC as a note, counts the message once and exits 0', async () => {
    const run = await mailroll(
      live('--json'),
      rejectFor('ada@example.com', ['records@example.net', 'audit@example.net']),
    );
    const list = listOf(run);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ needsAttention: false, mode: 'live' });
    expect(list.counts).toMatchObject({
      total: 4,
      sent: 3,
      failed: 0,
      uncertain: 0,
      notAttempted: 0,
      skipped: 1,
      ccRejectedMessages: 1,
      requiredCcRejectedMessages: 0,
    });
    expect(list.attention).toEqual([]);
    expect(list.ccRejected).toEqual([
      {
        address: 'ada@example.com',
        cc: ['records@example.net', 'audit@example.net'],
        required: false,
        attemptId: ANY_TEXT,
      },
    ]);
  });

  it('reports a required rejected CC as needing attention and exits 1, without queueing the message again', async () => {
    useCcPolicy('required');

    const run = await mailroll(live('--json'), rejectFor('ada@example.com', ['records@example.net']));
    const list = listOf(run);

    expect(run.status).toBe(1);
    expect(list.counts).toMatchObject({ sent: 3, ccRejectedMessages: 1, requiredCcRejectedMessages: 1 });
    expect(list.attention).toEqual([
      expect.objectContaining({
        address: 'ada@example.com',
        status: 'cc-rejected',
        detail: QUEUE_NOTE,
      }),
    ]);

    const again = await mailroll(live('--json'), rejectFor('ada@example.com', ['records@example.net']));

    expect(again.status).toBe(0);
    expect(listOf(again).counts).toMatchObject({ sent: 0, skipped: 4, ccRejectedMessages: 0 });
    expect(calls.filter((to) => to === 'ada@example.com')).toHaveLength(1);
  });

  it('exits 1 when an optional rejected CC comes with another reason for attention', async () => {
    const run = await mailroll(live('--json'), (message) =>
      message.to === 'grace@example.com'
        ? { outcome: 'unknown', detail: 'connection reset after DATA' }
        : { outcome: 'accepted', ccRejected: message.to === 'ada@example.com' ? ['records@example.net'] : [] },
    );
    const list = listOf(run);

    expect(run.status).toBe(1);
    expect(list.counts).toMatchObject({ uncertain: 1, ccRejectedMessages: 1, requiredCcRejectedMessages: 0 });
    expect(list.attention).toEqual([
      expect.objectContaining({ address: 'grace@example.com', status: 'uncertain', attemptId: ANY_TEXT }),
    ]);
  });

  it('keeps the text summary lines it printed before, and adds the CC and evidence lines', async () => {
    useCcPolicy('required');

    const run = await mailroll(live(), rejectFor('ada@example.com', ['records@example.net']));
    const lines = run.stdout.split('\n');

    expect(lines).toContain(
      '  welcome · recipients.csv [pending] needs attention: sent 3, failed 0, uncertain 0, not attempted 0, skipped 1, CC rejected on 1 message(s) (1 required)',
    );
    expect(lines.some((line) => line.startsWith('    history: ') && line.endsWith('recipients.json'))).toBe(true);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {4}CC REJECTED \(required\): ada@example\.com — required CC rejected: records@example\.net/,
      ),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^ {6}attempt \S+ \(for tracing; not proof of delivery\)$/));
  });

  it('prints exactly the old list line when nothing new happened', async () => {
    const run = await mailroll(live());

    expect(run.stdout.split('\n')).toContain(
      '  welcome · recipients.csv [pending] ok: sent 3, failed 0, uncertain 0, not attempted 0, skipped 1',
    );
    expect(run.stdout).not.toMatch(/CC rejected|note:|attempt /);
  });
});

describe('rejected CC in a test send', () => {
  it('never claims the provider accepted the message for the list recipient, and records nothing', async () => {
    useCcPolicy('required');

    const json = await mailroll(
      [...SEND, '-m', 'test', '--to', 'me@example.com', '--cc', CC, '--json'],
      rejectFor('me@example.com', ['records@example.net']),
    );
    const list = listOf(json);

    expect(json.status).toBe(1);
    expect(list.counts).toMatchObject({ sent: 3, ccRejectedMessages: 3, requiredCcRejectedMessages: 3 });
    expect(list.attention).toHaveLength(3);

    for (const item of list.attention) {
      expect(item).toEqual(expect.objectContaining({ status: 'cc-rejected', detail: TEST_NOTE }));
    }

    expect(JSON.stringify(list.attention)).not.toContain('not queued again');

    const later = await mailroll(live('--json'));

    expect(listOf(later).counts).toMatchObject({ sent: 3, skipped: 1 });
  });
});

describe('the evidence shown by status', () => {
  it('lists uncertain and CC-rejected messages as evidence, keeps the old counts and exits 0', async () => {
    useCcPolicy('required');
    await mailroll(live(), (message) =>
      message.to === 'grace@example.com'
        ? { outcome: 'unknown', detail: 'reset' }
        : {
            outcome: 'accepted',
            providerMessageId: 'p-1',
            ccRejected: message.to === 'ada@example.com' ? ['records@example.net'] : [],
          },
    );

    const run = await mailroll(['status', '--json']);
    const [campaign] = JSON.parse(run.stdout) as { templates: { lists: Record<string, unknown>[] }[] }[];
    const list = campaign?.templates[0]?.lists[0];

    expect(run.status).toBe(0);
    expect(list).toMatchObject({
      dataFile: 'recipients.csv',
      history: 'v2',
      counts: {
        total: 3,
        sent: 2,
        failed: 0,
        uncertain: 1,
        pending: 0,
        rejected: 1,
        ccRejectedMessages: 1,
        requiredCcRejectedMessages: 1,
      },
    });
    expect(list?.['evidence']).toEqual([
      expect.objectContaining({
        email: 'ada@example.com',
        status: 'sent',
        providerMessageId: 'p-1',
        cc: { rejected: ['records@example.net'], required: true },
        attemptId: ANY_TEXT,
      }),
      expect.objectContaining({ email: 'grace@example.com', status: 'uncertain', attemptId: ANY_TEXT }),
    ]);

    const text = await mailroll(['status']);

    expect(text.status).toBe(0);
    expect(text.stdout).toContain('· CC rejected 1 (1 required)');
    expect(text.stdout).toMatch(
      /ada@example\.com: sent · CC rejected \(required\): records@example\.net · attempt \S+ · provider id p-1 \(for tracing; not proof of delivery\)/,
    );
    expect(text.stdout).toMatch(/grace@example\.com: UNCERTAIN · attempt \S+ \(for tracing; not proof of delivery\)/);
  });
});

describe('the history upgrade from v1', () => {
  async function v1History(): Promise<string> {
    const dry = await mailroll([...SEND, '-m', 'dry-run', '--cc', '', '--json']);
    const statePath = listOf(dry).statePath;

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, fixture('snapshot.json'));
    writeFileSync(`${statePath}l`, fixture('journal-mixed.jsonl'));

    return statePath;
  }

  it('warns in a dry run that the next live run upgrades the history, and changes no file', async () => {
    const statePath = await v1History();
    const before = dirContents(dirname(statePath));
    const json = await mailroll([...SEND, '-m', 'dry-run', '--cc', '', '--json']);
    const text = await mailroll([...SEND, '-m', 'dry-run', '--cc', '']);

    expect(listOf(json).history).toEqual({ before: 'v1', upgraded: false });
    expect(text.stdout).toContain('history is in the v1 format; the next live run upgrades it to v2 (one-way)');
    expect(dirContents(dirname(statePath))).toEqual(before);
  });

  it('reports the upgrade only once a live run has completed it, with its backups', async () => {
    const statePath = await v1History();
    const run = await mailroll(live('--json'));

    expect(listOf(run).history).toEqual({
      before: 'v1',
      upgraded: true,
      backups: [`${statePath}.v1-backup`, `${statePath}l.v1-backup`],
    });
    expect(run.stderr).toContain('state.history_upgraded');
    expect(existsSync(`${statePath}.v1-backup`)).toBe(true);

    const status = await mailroll(['status', '--json']);

    const [campaign] = JSON.parse(status.stdout) as { templates: { lists: { history?: string }[] }[] }[];

    expect(campaign?.templates[0]?.lists[0]?.history).toBe('v2');

    const next = await mailroll(live('--json'));

    expect(listOf(next).history).toEqual({ before: 'v2', upgraded: false });
    expect(next.stderr).not.toContain('state.history_upgraded');
  });

  it('does not announce an upgrade it did not do when an earlier run left it half-done', async () => {
    const dry = await mailroll([...SEND, '-m', 'dry-run', '--cc', '', '--json']);
    const statePath = listOf(dry).statePath;

    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 2, templateId: 'welcome', recipients: {}, updatedAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    writeFileSync(
      `${statePath}l`,
      fixture('journal-no-newline.jsonl').replaceAll('kim@example.com', 'zed@example.com'),
    );

    const run = await mailroll(live('--json'));

    expect(listOf(run).history).toEqual({ before: 'v2', upgraded: false });
    expect(run.stderr).not.toContain('state.history_upgraded');
  });

  it('says the upgrade could not be confirmed when the live run could not complete it', async () => {
    const statePath = await v1History();

    writeFileSync(`${statePath}l`, fixture('journal-invalid-tail.jsonl'));

    const run = await mailroll(live('--json'));

    expect(run.status).not.toBe(0);
    expect(listOf(run).history).toEqual({ before: 'v1', upgraded: false, unconfirmed: true });
    expect(run.stderr).not.toContain('state.history_upgraded');

    const text = await mailroll(live());

    expect(text.stdout).toContain(
      `history upgrade could not be confirmed; check ${statePath} before using an older mailroll`,
    );
  });

  it('says a list with no history has none', async () => {
    const run = await mailroll([...SEND, '-m', 'dry-run', '--cc', '', '--json']);

    expect(listOf(run).history).toEqual({ before: 'none', upgraded: false });
    expect(readdirSync(campaigns).length).toBeGreaterThan(0);
  });
});
