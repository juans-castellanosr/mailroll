import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined
    ) {
      found.push(ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : '<computed>');
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

describe('the core source', () => {
  it('imports only its own modules, through relative paths that stay inside src', () => {
    const escapes = sourceFiles(SRC).flatMap((file) =>
      specifiers(file)
        .filter((specifier) => {
          if (!specifier.startsWith('.')) {
            return true;
          }

          const target = resolve(dirname(file), specifier);

          return target !== SRC && !target.startsWith(`${SRC}${sep}`);
        })
        .map((specifier) => `${relative(SRC, file)}: ${specifier}`),
    );

    expect(escapes).toEqual([]);
  });
});
