import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const PACKAGES = join(REPO, 'packages');

describe('package licenses', () => {
  const license = readFileSync(join(REPO, 'LICENSE'), 'utf8');
  const packages = readdirSync(PACKAGES, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(PACKAGES, entry.name, 'package.json')),
  );

  it('finds the workspace packages', () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages.map((entry) => entry.name))('packages/%s ships the repository LICENSE unchanged', (name) => {
    expect(readFileSync(join(PACKAGES, name, 'LICENSE'), 'utf8')).toBe(license);
  });
});
