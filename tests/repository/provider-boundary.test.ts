import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const PROVIDER_NEUTRAL_PACKAGES = ['core', 'mailroll'];
const PROVIDER_SPECIFIC = /outlook|msal|microsoft[\s-]?graph/i;
const PROVIDER_PACKAGES = ['@mailroll/outlook', '@azure/msal-node'];
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return entry.name === '.claude' ? [] : sourceFiles(path);
    }

    return /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

describe('the provider-neutral packages', () => {
  it.each(PROVIDER_NEUTRAL_PACKAGES)('packages/%s/src names no provider brand or provider package', (name) => {
    const offenders = sourceFiles(join(REPO, 'packages', name, 'src'))
      .filter((file) => PROVIDER_SPECIFIC.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO, file));

    expect(offenders).toEqual([]);
  });

  it.each(PROVIDER_NEUTRAL_PACKAGES)('packages/%s/package.json depends on no provider package', (name) => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages', name, 'package.json'), 'utf8')) as Partial<
      Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
    >;
    const declared = DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));

    expect(declared.filter((dependency) => PROVIDER_PACKAGES.includes(dependency))).toEqual([]);
  });
});
