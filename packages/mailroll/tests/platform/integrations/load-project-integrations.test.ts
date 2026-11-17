import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import {
  describeImportFailure,
  loadProjectIntegrations,
} from '../../../src/platform/integrations/load-project-integrations';
import { importHelperPath } from '../../../src/platform/integrations/project-import-helper';
import { createUserProject, isRunningHostFixture, type UserProjectFixture } from './user-project';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function project(dependencies: readonly string[], host?: string): Promise<UserProjectFixture> {
  const created = await createUserProject(dependencies, host === undefined ? {} : { host });

  cleanup.push(created.dir);

  return created;
}

function load(cwd: string) {
  return loadProjectIntegrations({ cwd, isRunningHost: isRunningHostFixture });
}

describe('loading the integrations a project declares', () => {
  it('does nothing outside a project that declares mailroll and has no mailroll.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailroll-bare-'));

    cleanup.push(dir);

    await expect(load(dir)).resolves.toEqual([]);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  });

  it('does nothing, and writes no helper, when the project has no mailroll.json', async () => {
    const { dir } = await project([]);

    await expect(load(dir)).resolves.toEqual([]);
    expect(existsSync(importHelperPath(dir))).toBe(false);
  });

  it('refuses a mailroll.json that no project declaring mailroll owns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailroll-stray-'));

    cleanup.push(dir);
    writeFileSync(join(dir, 'mailroll.json'), JSON.stringify({ integrations: ['acme-mailroll-sender'] }));

    await expect(load(dir)).rejects.toThrow(
      /mailroll\.json must sit next to the package\.json that installs mailroll, but there is no package\.json in/,
    );
  });

  it('finds the project from a subdirectory', async () => {
    const created = await project(['acme-mailroll-sender']);
    const nested = join(created.dir, 'campaigns', 'group');

    mkdirSync(nested, { recursive: true });
    created.installFixture('acme-mailroll-sender');
    created.writeList(['acme-mailroll-sender']);

    await expect(load(nested)).resolves.toHaveLength(1);
  });

  it.each([
    ['not JSON', '{', /invalid JSON in .*mailroll\.json/],
    ['an unknown field', JSON.stringify({ integrations: [], plugins: [] }), /invalid .*mailroll\.json: .*plugins/],
    ['a relative path', JSON.stringify({ integrations: ['./local.js'] }), /must name an installed package/],
    ['a node built-in', JSON.stringify({ integrations: ['node:fs'] }), /must name an installed package/],
    ['a URL', JSON.stringify({ integrations: ['https://x.test/i.js'] }), /must name an installed package/],
    ['a repeated entry', JSON.stringify({ integrations: ['a', 'a'] }), /each integration may be listed once/],
  ])('rejects a mailroll.json with %s', async (_label, content, message) => {
    const { dir } = await project([]);

    writeFileSync(join(dir, 'mailroll.json'), content);

    await expect(load(dir)).rejects.toThrow(message);
  });

  it('refuses to load a listed package the project does not declare, before importing anything', async () => {
    const created = await project([]);

    created.installFixture('acme-mailroll-sender');
    created.writeList(['acme-mailroll-sender']);

    await expect(load(created.dir)).rejects.toThrow(
      /lists "acme-mailroll-sender", which is not declared in .*package\.json; add it to the project dependencies/,
    );
    expect(existsSync(importHelperPath(created.dir))).toBe(false);
  });

  it('refuses to run when this mailroll is not the copy installed in the project', async () => {
    const created = await project(['acme-mailroll-sender'], 'another copy');

    created.installFixture('acme-mailroll-sender');
    created.writeList(['acme-mailroll-sender']);

    await expect(load(created.dir)).rejects.toThrow(
      /this mailroll is not the copy installed in the project.*"npx mailroll", "pnpm exec mailroll" or "yarn mailroll"/,
    );
  });

  it('reports every integration that cannot load, each with its own reason, in one error', async () => {
    const created = await project(['acme-missing', 'acme-throws', 'acme-empty', 'acme-sealed']);

    created.installPackage('acme-throws', { 'index.mjs': "throw new Error('boom at import');\n" });
    created.installPackage('acme-empty', { 'index.mjs': 'export const nothing = 1;\n' });
    created.installPackage('acme-sealed', { 'index.mjs': 'export default {};\n' }, { './internal': './index.mjs' });
    created.writeList(['acme-missing', 'acme-throws', 'acme-empty', 'acme-sealed']);

    const error = await load(created.dir).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/"acme-missing" is not installed or cannot be resolved from the project/);
    expect((error as Error).message).toMatch(/"acme-throws" failed while loading: boom at import/);
    expect((error as Error).message).toMatch(/"acme-empty" has no default export; it is not a mailroll integration/);
    expect((error as Error).message).toMatch(/"acme-sealed" has no importable entry/);
  });

  it('says so when Node.js refuses an integration published as TypeScript', async () => {
    const created = await project(['acme-ts']);

    created.installPackage(
      'acme-ts',
      { 'index.ts': 'const descriptor: object = {};\nexport default descriptor;\n' },
      './index.ts',
    );
    created.writeList(['acme-ts']);

    await expect(load(created.dir)).rejects.toThrow(
      /"acme-ts" loads TypeScript from node_modules \(the integration or one of its dependencies\); integrations must ship JavaScript/,
    );
  });

  it('loads a declared integration through the project, and never runs code that is not listed', async () => {
    const created = await project(['acme-mailroll-sender', 'acme-tripwire']);

    created.installFixture('acme-mailroll-sender');
    created.installFixture('acme-tripwire');
    created.writeList(['acme-mailroll-sender']);

    const sources = await load(created.dir);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.origin).toBe(`"acme-mailroll-sender" (${join(created.dir, 'mailroll.json')})`);
    expect(sources[0]?.descriptor).toMatchObject({ kind: 'mailroll.integration', id: 'acme-sender' });
    expect(existsSync(join(process.cwd(), 'acme-tripwire-was-loaded'))).toBe(false);
    expect(existsSync(join(created.dir, 'acme-tripwire-was-loaded'))).toBe(false);
  });

  it('ignores an unrelated broken or byte-order-marked package.json above a project without mailroll.json', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'mailroll-outer-'));
    const inner = join(outer, 'campaigns');

    cleanup.push(outer);
    mkdirSync(inner);
    writeFileSync(join(outer, 'package.json'), '{ "name": ');
    writeFileSync(join(inner, 'package.json'), '\uFEFF{ "name": "not-mailroll" }');

    await expect(load(inner)).resolves.toEqual([]);
  });

  it('accepts a package.json and a mailroll.json saved with a byte-order mark', async () => {
    const created = await project(['acme-mailroll-sender']);

    created.installFixture('acme-mailroll-sender');
    writeFileSync(
      join(created.dir, 'package.json'),
      `\uFEFF${JSON.stringify({ dependencies: { mailroll: '*', 'acme-mailroll-sender': '*' } })}`,
    );
    writeFileSync(
      join(created.dir, 'mailroll.json'),
      `\uFEFF${JSON.stringify({ integrations: ['acme-mailroll-sender'] })}`,
    );

    await expect(load(created.dir)).resolves.toHaveLength(1);
  });

  it('refuses a mailroll.json placed in a workspace package that does not declare mailroll', async () => {
    const created = await project([]);
    const workspace = join(created.dir, 'packages', 'campaigns');

    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'campaigns' }));
    writeFileSync(join(workspace, 'mailroll.json'), JSON.stringify({ integrations: ['acme-mailroll-sender'] }));

    await expect(load(workspace)).rejects.toThrow(
      /mailroll\.json must sit next to the package\.json that installs mailroll, but .*package\.json does not declare mailroll/,
    );
  });

  it.each([['acme/../other'], ['acme/./x'], ['@acme/sender/../../other']])(
    'rejects the subpath %s',
    async (specifier) => {
      const { dir } = await project([]);

      writeFileSync(join(dir, 'mailroll.json'), JSON.stringify({ integrations: [specifier] }));

      await expect(load(dir)).rejects.toThrow(/a subpath may not contain "\." or "\.\." segments/);
    },
  );

  it('blames neither mailroll.json nor TypeScript for a dependency of the integration that hides an entry', async () => {
    const created = await project(['acme-uses-private']);

    created.installPackage('acme-uses-private', { 'index.mjs': "export { default } from 'acme-dep/internal';\n" });
    created.installPackage('acme-dep', { 'index.mjs': 'export default 1;\n' }, { '.': './index.mjs' });
    created.writeList(['acme-uses-private']);

    await expect(load(created.dir)).rejects.toThrow(
      /"acme-uses-private" failed while loading: Package subpath '\.\/internal'/,
    );
  });

  it('reports a thrown value that cannot even be printed, and keeps every original error as the cause', async () => {
    const created = await project(['acme-odd', 'acme-throws']);

    created.installPackage('acme-odd', { 'index.mjs': 'throw Object.create(null);\n' });
    created.installPackage('acme-throws', { 'index.mjs': "throw new Error('boom');\n" });
    created.writeList(['acme-odd', 'acme-throws']);

    const error = await load(created.dir).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(
      /"acme-odd" failed while loading: an unprintable value; "acme-throws" failed while loading: boom/,
    );
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toHaveLength(2);
  });

  it('treats an empty list as no integrations', async () => {
    const created = await project([]);

    created.writeList([]);

    await expect(load(created.dir)).resolves.toEqual([]);
    expect(existsSync(importHelperPath(created.dir))).toBe(false);
  });
});

describe('describing an import failure', () => {
  it('names an integration published as TypeScript', () => {
    const error = Object.assign(new Error('Stripping types is unsupported for files under node_modules'), {
      code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
    });

    expect(describeImportFailure('acme-ts', error)).toBe(
      'loads TypeScript from node_modules (the integration or one of its dependencies); integrations must ship JavaScript',
    );
  });

  it('calls only TypeScript extensions TypeScript', () => {
    const css = Object.assign(new Error('Unknown file extension ".css" for /p/node_modules/acme/style.css'), {
      code: 'ERR_UNKNOWN_FILE_EXTENSION',
    });
    const mts = Object.assign(new Error('Unknown file extension ".mts" for /p/node_modules/acme/index.mts'), {
      code: 'ERR_UNKNOWN_FILE_EXTENSION',
    });

    expect(describeImportFailure('acme', css)).toMatch(/^failed while loading: Unknown file extension ".css"/);
    expect(describeImportFailure('acme', mts)).toMatch(/^loads TypeScript from node_modules/);
  });

  it('survives an error whose message is not text', () => {
    const odd = Object.assign(new Error('x'), {
      message: {
        toString: () => {
          throw new Error('no');
        },
      },
    });

    expect(describeImportFailure('acme', odd)).toBe('failed while loading: an unprintable value');
  });

  it('does not blame the integration when one of its own dependencies is missing', () => {
    const error = Object.assign(new Error("Cannot find package 'left-pad' imported from /p/node_modules/acme/i.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

    expect(describeImportFailure('acme', error)).toMatch(/^failed while loading: Cannot find package 'left-pad'/);
  });
});
