import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, SendSelection } from '@mailroll/core';
import { runSelection } from '../../../src/platform/composition/build-runner';
import { integrationsForProject } from '../../../src/platform/composition/integrations';
import { createUserProject, isRunningHostFixture, type UserProjectFixture } from './user-project';

const CAMPAIGN_FIXTURE = resolve(import.meta.dirname, '../../fixtures/campaigns');
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let project: UserProjectFixture;
let tokens: string;

beforeEach(async () => {
  project = await createUserProject(['acme-mailroll-sender']);
  project.installFixture('acme-mailroll-sender');
  tokens = mkdtempSync(join(tmpdir(), 'mailroll-state-'));
  cpSync(CAMPAIGN_FIXTURE, join(project.dir, 'campaigns'), { recursive: true });
});
afterEach(() => {
  rmSync(project.dir, { recursive: true, force: true });
  rmSync(tokens, { recursive: true, force: true });
});

function useConnection(settings?: unknown): void {
  writeFileSync(
    join(project.dir, 'campaigns', 'acme', 'onboarding', 'connections', 'outlook-1.json'),
    JSON.stringify({
      id: 'outlook-1',
      kind: 'acme-sender',
      mailbox: 'sender@example.com',
      ...(settings === undefined ? {} : { settings }),
    }),
  );
}

function selection(mode: SendSelection['mode']): SendSelection {
  return {
    campaignId: 'acme/onboarding',
    targets: [{ templateId: 'welcome' }],
    connectionIds: ['outlook-1'],
    policy: { kind: 'pending' },
    mode,
  };
}

async function run(mode: SendSelection['mode']) {
  const integrations = await integrationsForProject({ cwd: project.dir, isRunningHost: isRunningHostFixture });

  return runSelection(selection(mode), {
    campaignsRoot: join(project.dir, 'campaigns'),
    logger: silent,
    env: { TOKEN_CACHE_PATH: tokens },
    integrations,
  });
}

function outbox(): { event: string; to?: string }[] {
  const path = join(tokens, 'acme_onboarding', 'acme-outbox.jsonl');

  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string; to?: string })
    : [];
}

describe('an installed external integration declared in mailroll.json', () => {
  it('validates in a dry run but is never prepared and never sends', async () => {
    project.writeList(['acme-mailroll-sender']);
    useConnection();

    const [result] = await run({ kind: 'dry-run' });

    expect(result?.report).toMatchObject({ sent: 3, skipped: 1, failed: 0 });
    expect(outbox()).toEqual([]);
  });

  it('receives a validated sender from the engine and records every send in the history', async () => {
    project.writeList(['acme-mailroll-sender']);
    useConnection();

    const [result] = await run({ kind: 'live' });

    expect(result?.report).toMatchObject({ sent: 3, failed: 0, uncertain: 0, skipped: 1 });
    expect(outbox().map((entry) => entry.event)).toEqual(['prepare', 'send', 'send', 'send']);
    expect(outbox().flatMap((entry) => (entry.to === undefined ? [] : [entry.to]))).toEqual([
      'ada@example.com',
      'grace@example.com',
      'alan@example.org',
    ]);

    const [again] = await run({ kind: 'live' });

    expect(again?.report).toMatchObject({ sent: 0, skipped: 4 });
    expect(outbox().filter((entry) => entry.event === 'send')).toHaveLength(3);
  });

  it('keeps an unconfirmed send uncertain instead of failed, so it is never resent automatically', async () => {
    project.writeList(['acme-mailroll-sender']);
    useConnection({ outcome: 'unknown' });

    const [result] = await run({ kind: 'live' });

    expect(result?.report.sent).toBe(0);
    expect(result?.report.failed).toBe(0);
    expect(result?.report.uncertain).toBeGreaterThan(0);

    const uncertainBefore = new Set(outbox().flatMap((entry) => (entry.event === 'send' ? [entry.to] : [])));

    await run({ kind: 'live' });

    const resent = outbox()
      .filter((entry) => entry.event === 'send')
      .slice(uncertainBefore.size)
      .map((entry) => entry.to);

    expect(resent.filter((to) => uncertainBefore.has(to))).toEqual([]);
  });

  it('is not active once removed from mailroll.json, even though it stays installed', async () => {
    project.writeList([]);
    useConnection();

    await expect(run({ kind: 'live' })).rejects.toThrow(
      /connection "outlook-1" uses the integration "acme-sender", which is not active/,
    );
    expect(outbox()).toEqual([]);
  });
});

describe('activating declared integrations', () => {
  it('lets a declared integration use the id outlook, because no integration is built in', async () => {
    project.installPackage('acme-outlook-clone', {
      'index.mjs': "import base from 'acme-mailroll-sender';\nexport default { ...base, id: 'outlook' };\n",
    });
    writeFileSync(
      join(project.dir, 'package.json'),
      JSON.stringify({ dependencies: { mailroll: '*', 'acme-mailroll-sender': '*', 'acme-outlook-clone': '*' } }),
    );
    project.writeList(['acme-outlook-clone']);

    const integrations = await integrationsForProject({ cwd: project.dir, isRunningHost: isRunningHostFixture });

    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({ id: 'outlook' });
  });

  it('rejects two declared integrations with the same id', async () => {
    project.installPackage('acme-twin', { 'index.mjs': "export { default } from 'acme-mailroll-sender';\n" });
    writeFileSync(
      join(project.dir, 'package.json'),
      JSON.stringify({ dependencies: { mailroll: '*', 'acme-mailroll-sender': '*', 'acme-twin': '*' } }),
    );
    project.writeList(['acme-mailroll-sender', 'acme-twin']);

    await expect(integrationsForProject({ cwd: project.dir, isRunningHost: isRunningHostFixture })).rejects.toThrow(
      /two active integrations share the id "acme-sender" \("acme-mailroll-sender" .* and "acme-twin" .*\)/,
    );
  });

  it('rejects an integration built for a sender contract this mailroll does not support', async () => {
    project.installPackage('acme-future', {
      'index.mjs':
        "import base from 'acme-mailroll-sender';\n" +
        "export default { ...base, id: 'acme-future', roles: { sender: { ...base.roles.sender, contract: 'sender/9' } } };\n",
    });
    writeFileSync(
      join(project.dir, 'package.json'),
      JSON.stringify({ dependencies: { mailroll: '*', 'acme-mailroll-sender': '*', 'acme-future': '*' } }),
    );
    project.writeList(['acme-future']);

    await expect(integrationsForProject({ cwd: project.dir, isRunningHost: isRunningHostFixture })).rejects.toThrow(
      /"acme-future" \(.*mailroll\.json\) is not a valid mailroll integration: .*sender\/9/,
    );
  });

  it('activates nothing when the project declares no integration', async () => {
    await expect(integrationsForProject({ cwd: project.dir, isRunningHost: isRunningHostFixture })).resolves.toEqual(
      [],
    );
  });
});
