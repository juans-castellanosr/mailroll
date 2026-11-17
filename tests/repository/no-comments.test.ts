import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');

const CODE_ROOTS = ['packages', 'scripts', 'tests', 'eslint.config.js', 'vitest.config.ts'];
const LINE_ROOTS = ['.github', 'pnpm-workspace.yaml', '.gitignore', '.gitattributes', '.prettierignore', 'env.example'];

const CODE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const LINE_EXTENSIONS = ['.yml', '.yaml'];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.pack', 'coverage']);
const PACKAGE_RUN_OUTPUTS = new Set(['campaigns', 'previews']);

function isPackageRunOutput(entry: string): boolean {
  const [root, , directory, ...rest] = entry.split(sep);

  return root === 'packages' && directory !== undefined && rest.length === 0 && PACKAGE_RUN_OUTPUTS.has(directory);
}

function filesUnder(entry: string, accepts: (path: string) => boolean): string[] {
  const path = join(REPO, entry);

  if (statSync(path).isFile()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((child) => {
    if (child.isDirectory()) {
      const childEntry = join(entry, child.name);

      return SKIPPED_DIRECTORIES.has(child.name) || isPackageRunOutput(childEntry)
        ? []
        : filesUnder(childEntry, accepts);
    }

    const file = join(path, child.name);

    return accepts(file) ? [file] : [];
  });
}

function codeComments(file: string): number[] {
  const text = readFileSync(file, 'utf8');
  const kind = /\.[cm]?tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const positions = new Set<number>();
  const collect = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      positions.add(range.pos);
    }
  };

  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) {
      visit(child);
    }
  };

  visit(source);

  return [...positions].map((position) => source.getLineAndCharacterOfPosition(position).line + 1);
}

function lineComments(file: string): number[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => (/^\s*#|\s#\s/.test(line.replace(/'[^']*'|"[^"]*"/g, '')) ? [index + 1] : []));
}

function findings(roots: readonly string[], accepts: (path: string) => boolean, scan: (file: string) => number[]) {
  return roots
    .flatMap((root) => filesUnder(root, accepts))
    .flatMap((file) => scan(file).map((line) => `${relative(REPO, file)}:${String(line)}`));
}

describe('the repository', () => {
  it('has no comments in code', () => {
    const found = findings(CODE_ROOTS, (file) => CODE_EXTENSIONS.some((ext) => file.endsWith(ext)), codeComments);

    expect(found).toEqual([]);
  });

  it('has no comments in YAML, ignore files or the environment template', () => {
    const found = findings(
      LINE_ROOTS,
      (file) => LINE_EXTENSIONS.some((ext) => file.endsWith(ext)) || !file.includes('.github'),
      lineComments,
    );

    expect(found).toEqual([]);
  });
});
