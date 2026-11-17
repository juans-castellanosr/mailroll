import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  INTEGRATION_KIND,
  type IntegrationDescriptor,
  type Message,
  SENDER_CONTRACT,
  type SendOutcome,
  valid,
} from '@mailroll/core';
import { createOutput } from '../../src/platform/cli/output';
import { connectionEnvKey } from '../../src/platform/config/resolve-connection-secrets';
import { parseJournal, parseSnapshot } from '../../src/platform/state/history-format';
import type { Output } from '../../src/platform/cli/output';
import { runCli } from '../../src/platform/cli/program';

const PACKAGE = resolve(import.meta.dirname, '../..');
const DOCS = resolve(PACKAGE, '../../docs');
const FIXTURE = join(PACKAGE, 'tests/fixtures/campaigns/acme/onboarding');
const NODE_TYPES = dirname(dirname(createRequire(import.meta.url).resolve('@types/node/package.json')));
const QUICKSTART_PREFIX = 'campaigns/acme/onboarding/';
const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join('/');

const PUBLIC_API_COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: ['node'],
  typeRoots: [NODE_TYPES],
  baseUrl: PACKAGE,
  paths: {
    '@mailroll/core': ['../core/src/index.ts'],
    '@mailroll/outlook': ['../outlook/src/index.ts'],
    mailroll: ['src/exports/node.ts'],
    'mailroll/core': ['src/exports/core.ts'],
  },
};

interface CodeBlock {
  readonly page: string;
  readonly language: string;
  readonly title: string | undefined;
  readonly code: string;
}

function pages(dir = DOCS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return pages(path);
    }

    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

function codeBlocks(page: string): CodeBlock[] {
  const text = readFileSync(page, 'utf8');
  const blocks: CodeBlock[] = [];
  const fence = /^([ \t]*)```(\w+)(?:[ \t]+(\S+))?[^\n]*\n([\s\S]*?)^\1```[ \t]*$/gm;

  for (const match of text.matchAll(fence)) {
    const [, indent = '', language = '', title, body = ''] = match;
    const code = body
      .split('\n')
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join('\n');

    blocks.push({ page: posixRelative(DOCS, page), language, title, code });
  }

  return blocks;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

async function help(args: readonly string[]): Promise<string> {
  let text = '';
  const silent: Output = {
    data: () => undefined,
    json: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  await runCli([...args, '--help'], {
    out: silent,
    env: {},
    interactive: false,
    cwd: process.cwd(),
    loadIntegrations: () => Promise.resolve([]),
    writeOut: (chunk) => {
      text += chunk;
    },
    writeErr: (chunk) => {
      text += chunk;
    },
  });

  return text;
}

const longOptions = (text: string): Set<string> => new Set(text.match(/--[a-z][a-z-]*/g) ?? []);

describe('the documentation', () => {
  it('lists only pages that exist, and every page is in the navigation', () => {
    const config = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8')) as {
      navigation: { groups: { pages: string[] }[] };
    };
    const listed = config.navigation.groups.flatMap((group) => group.pages);

    expect(listed.filter((page) => !existsSync(join(DOCS, `${page}.mdx`)))).toEqual([]);

    const onDisk = pages().map((page) => posixRelative(DOCS, page).replace(/\.mdx$/, ''));

    expect(onDisk.sort()).toEqual([...listed].sort());
  });

  it('shows exactly the files of the quickstart campaign', () => {
    const shown = new Map(
      codeBlocks(join(DOCS, 'quickstart.mdx'))
        .filter((block) => block.title?.startsWith(QUICKSTART_PREFIX) === true)
        .map((block) => [block.title?.slice(QUICKSTART_PREFIX.length) ?? '', block.code]),
    );
    const fixture = filesUnder(FIXTURE).map((file) => posixRelative(FIXTURE, file));

    expect([...shown.keys()].sort()).toEqual(fixture.sort());
    for (const file of fixture) {
      expect(shown.get(file)?.trimEnd(), file).toBe(readFileSync(join(FIXTURE, file), 'utf8').trimEnd());
    }
  });

  it('documents every CLI command and option, and nothing else', async () => {
    const cliPages = pages(join(DOCS, 'cli'));
    const reference = cliPages.map((page) => readFileSync(page, 'utf8')).join('\n');
    const root = await help([]);
    const section = root.slice(root.indexOf('Commands:')).split('\n\n')[0] ?? '';
    const commands = [...section.matchAll(/^ {2}([a-z][a-z-]*) /gm)]
      .map((match) => match[1] ?? '')
      .filter((c) => c !== '');

    expect(commands.length).toBeGreaterThan(0);

    const real = longOptions(root);

    for (const command of commands) {
      const page = join(DOCS, 'cli', `${command}.mdx`);

      expect(existsSync(page), `cli/${command}.mdx`).toBe(true);
      expect(readFileSync(page, 'utf8')).toContain(`## mailroll ${command}`);
      for (const option of longOptions(await help([command]))) {
        real.add(option);
      }
    }

    expect(
      [...real].filter((option) => !reference.includes(`\`${option}`) && !reference.includes(` ${option}`)),
    ).toEqual([]);
    expect([...longOptions(reference)].filter((option) => !real.has(option))).toEqual([]);
  });

  describe('TypeScript snippets', { timeout: 60_000 }, () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mailroll-docs-'));
    const broken: readonly (readonly [name: string, code: string, expected: string])[] = [
      [
        'a store returning a v1 state as TemplateState',
        "import type { TemplateState } from 'mailroll';\nexport const state: TemplateState = { version: 1, templateId: 't', recipients: {}, updatedAt: 'T' };",
        "'1'",
      ],
      [
        'load() assigned to TemplateState',
        "import type { ResolvedTemplate, StateStore, TemplateState } from 'mailroll';\nexport async function read(store: StateStore, template: ResolvedTemplate): Promise<TemplateState> {\n  const state: TemplateState = await store.load(template);\n  return state;\n}",
        'TemplateState',
      ],
      [
        'a version === 1 check in compact',
        "import type { TemplateState } from 'mailroll';\nexport const old = (state: TemplateState): boolean => state.version === 1;",
        'no overlap',
      ],
      [
        'a RunReport literal',
        "import type { RunReport } from 'mailroll';\nexport const built: RunReport = { total: 0, sent: 0, failed: 0, uncertain: 0, notAttempted: 0, skipped: 0, heldUncertain: 0, results: [] };",
        'ccRejectedMessages',
      ],
      [
        'a TemplateRunResult literal',
        "import { report, type TemplateRunResult } from 'mailroll';\nexport const built: TemplateRunResult = { templateId: 'welcome', dataFile: 'recipients.csv', policy: 'pending', statePath: 's', report: report([]) };",
        'history',
      ],
      [
        'a ListCounts literal',
        "import type { ListCounts } from 'mailroll';\nexport const counts: ListCounts = { total: 1, sent: 1, failed: 0, uncertain: 0, pending: 0, rejected: 0 };",
        'ccRejectedMessages',
      ],
      [
        'a ListReport literal',
        "import type { ListReport } from 'mailroll';\nexport const list: ListReport = { dataFile: 'recipients.csv', counts: { total: 0, sent: 0, failed: 0, uncertain: 0, pending: 0, rejected: 0, ccRejectedMessages: 0, requiredCcRejectedMessages: 0 } };",
        'evidence',
      ],
    ];
    let diagnostics: ReadonlyMap<string, readonly string[]> | undefined;

    afterAll(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    function diagnosticsByOwner(): ReadonlyMap<string, readonly string[]> {
      if (diagnostics !== undefined) {
        return diagnostics;
      }

      const control = "export const broken: number = 'x';";
      const sources = [
        ...pages()
          .flatMap(codeBlocks)
          .filter((block) => block.language === 'ts')
          .map((block) => ({ owner: `docs:${block.page}`, code: block.code })),
        { owner: 'control', code: control },
        ...broken.map(([name, code]) => ({ owner: `broken:${name}`, code })),
      ];
      const owners = new Map(
        sources.map(({ owner, code }, index) => {
          const file = join(workDir, `snippet-${String(index)}.ts`);

          writeFileSync(file, `${code}\nexport {};\n`);

          return [resolve(file), owner];
        }),
      );
      const program = ts.createProgram([...owners.keys()], PUBLIC_API_COMPILER_OPTIONS);
      const found = new Map<string, string[]>(sources.map(({ owner }) => [owner, []]));

      for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        const owner = diagnostic.file === undefined ? undefined : owners.get(resolve(diagnostic.file.fileName));

        if (owner !== undefined) {
          found.get(owner)?.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        }
      }

      diagnostics = found;

      return found;
    }

    it('compile against the public API', () => {
      const found = diagnosticsByOwner();
      const docs = [...found].filter(([owner]) => owner.startsWith('docs:'));

      expect(docs.length).toBeGreaterThan(0);
      expect(found.get('control')).toHaveLength(1);
      expect(docs.flatMap(([owner, messages]) => messages.map((message) => `${owner}: ${message}`))).toEqual([]);
    });

    it('reject the code the migration guide lists as broken by mailroll 0.2', () => {
      const found = diagnosticsByOwner();

      for (const [name, , expected] of broken) {
        expect(found.get(`broken:${name}`)?.join('\n') ?? '', name).toContain(expected);
      }
    });
  });
});

describe('the documented v2 history examples', () => {
  const examples = pages()
    .flatMap(codeBlocks)
    .filter((block) => block.language === 'json' && /\.state\/[^/]+\.jsonl?$/.test(block.title ?? ''));

  it('exist for both the snapshot and the journal', () => {
    expect(examples.some((block) => block.title?.endsWith('.json') === true)).toBe(true);
    expect(examples.some((block) => block.title?.endsWith('.jsonl') === true)).toBe(true);
  });

  it.each(examples.map((block) => [`${block.page}: ${block.title ?? ''}`, block] as const))(
    '%s is accepted by the real v2 reader',
    (_label, block) => {
      const title = block.title ?? '';
      const bytes = Buffer.from(`${block.code.trimEnd()}\n`);
      const parsed = title.endsWith('.jsonl') ? parseJournal(title, bytes) : parseSnapshot(title, bytes);

      expect(parsed.kind).toBe('v2');
    },
  );
});

type Shape = Map<string, string>;

function shapeOf(value: unknown, path = '$', shape: Shape = new Map()): Shape {
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

  shape.set(path, kind);

  if (Array.isArray(value)) {
    for (const item of value) {
      shapeOf(item, `${path}[]`, shape);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      shapeOf(item, `${path}.${key}`, shape);
    }
  }

  return shape;
}

function keysAt(value: unknown, path: readonly string[]): string[][] {
  if (path.length === 0) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? [Object.keys(value)] : [];
  }

  const [head, ...rest] = path;

  if (head === '[]') {
    return Array.isArray(value) ? value.flatMap((item) => keysAt(item, rest)) : [];
  }

  return typeof value === 'object' && value !== null && head !== undefined
    ? keysAt(Reflect.get(value, head), rest)
    : [];
}

function scriptedSender(
  script: (message: Message) => SendOutcome,
): IntegrationDescriptor<Readonly<Record<string, never>>> {
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
            send: (message: Message) => Promise.resolve(script(message)),
            close: () => Promise.resolve(),
          }),
      },
    },
  };
}

describe('the documented JSON output', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'mailroll-docs-output-'));
  const campaigns = join(workDir, 'campaigns');

  cpSync(join(PACKAGE, 'tests/fixtures/campaigns'), campaigns, { recursive: true });

  const templates = join(campaigns, 'acme/onboarding/templates');

  cpSync(join(templates, 'welcome'), join(templates, 'reminder'), { recursive: true });
  rmSync(join(templates, 'reminder', 'data'), { recursive: true, force: true });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function json(args: readonly string[]): Promise<unknown> {
    let stdout = '';
    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    });

    await runCli(['-C', campaigns, ...args], {
      out: createOutput({
        stdout: sink,
        stderr: new Writable({
          write: (_chunk, _encoding, done) => {
            done();
          },
        }),
      }),
      env: { [connectionEnvKey('acme/onboarding', 'outlook-1', 'TOKEN')]: 'secret' },
      interactive: false,
      cwd: workDir,
      loadIntegrations: () =>
        Promise.resolve([
          scriptedSender((message) =>
            message.to === 'alan@example.org'
              ? { outcome: 'unknown', detail: 'no answer' }
              : {
                  outcome: 'accepted',
                  providerMessageId: 'p-1',
                  ccRejected: message.to === 'ada@example.com' ? ['records@example.net'] : [],
                },
          ),
        ]),
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: () => undefined,
    });

    return JSON.parse(stdout) as unknown;
  }

  const SEND = ['send', '-c', 'acme/onboarding', '-t', 'welcome', '--connection', 'outlook-1'];

  it('matches real summaries and status reports in every documented key and type', async () => {
    const summaries = [
      await json([...SEND, '-m', 'dry-run', '--cc', '', '--write-previews', '--json']),
      await json([...SEND, '-m', 'live', '--confirm', '--cc', 'records@example.net', '--json']),
    ];
    const status = await json(['status', '--json']);
    const realSummary = new Map(summaries.flatMap((summary) => [...shapeOf(summary)]));
    const realStatus = shapeOf(status);
    const documented = pages()
      .flatMap(codeBlocks)
      .filter((block) => block.language === 'json')
      .flatMap((block) => {
        try {
          return [{ block, value: JSON.parse(block.code) as unknown }];
        } catch {
          return [];
        }
      });
    const docSummaries = documented.filter(
      ({ value }) => typeof value === 'object' && value !== null && 'lists' in value && 'mode' in value,
    );
    const docStatuses = documented.filter(({ block }) => block.page === 'cli/status.mdx');

    expect(docSummaries.length).toBeGreaterThanOrEqual(2);
    expect(docStatuses).toHaveLength(1);

    const mismatches = [
      ...docSummaries.flatMap(({ block, value }) =>
        [...shapeOf(value)].flatMap(([path, kind]) =>
          realSummary.get(path) === kind
            ? []
            : [`${block.page}: ${path} is ${kind}, real output has ${realSummary.get(path) ?? 'nothing'}`],
        ),
      ),
      ...docStatuses.flatMap(({ block, value }) =>
        [...shapeOf(value)].flatMap(([path, kind]) =>
          realStatus.get(path) === kind
            ? []
            : [`${block.page}: ${path} is ${kind}, real output has ${realStatus.get(path) ?? 'nothing'}`],
        ),
      ),
    ];

    expect(mismatches).toEqual([]);

    const always = (lists: string[][]): string[] =>
      (lists[0] ?? []).filter((key) => lists.every((keys) => keys.includes(key)));
    const summaryListKeys = always(summaries.flatMap((summary) => keysAt(summary, ['lists', '[]'])));
    const statusListKeys = always(keysAt(status, ['[]', 'templates', '[]', 'lists', '[]']));

    for (const { block, value } of docSummaries) {
      for (const keys of keysAt(value, ['lists', '[]'])) {
        expect(
          summaryListKeys.filter((key) => !keys.includes(key)),
          block.page,
        ).toEqual([]);
      }
    }

    for (const { block, value } of docStatuses) {
      for (const keys of keysAt(value, ['[]', 'templates', '[]', 'lists', '[]'])) {
        expect(
          statusListKeys.filter((key) => !keys.includes(key)),
          block.page,
        ).toEqual([]);
      }
    }
  });
});
