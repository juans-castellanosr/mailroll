import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const CLI = join(SRC, 'cli');
const LIBRARY_PACKAGES = new Set(['@mailroll/core', '@azure/msal-node', 'zod']);

interface Specifier {
  readonly file: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly dynamic: boolean;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function specifiersOf(file: string): Specifier[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Specifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({
        file,
        specifier: node.moduleSpecifier.text,
        typeOnly: node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
        dynamic: false,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ file, specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, dynamic: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;

      found.push({
        file,
        specifier: argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : '<computed>',
        typeOnly: false,
        dynamic: true,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push({ file, specifier: node.argument.literal.text, typeOnly: true, dynamic: false });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function staysInside(file: string, specifier: string): boolean {
  const target = resolve(dirname(file), specifier);

  return target === SRC || target.startsWith(`${SRC}${sep}`);
}

function reachesCli(file: string, specifier: string): boolean {
  const target = resolve(dirname(file), specifier);

  return target === CLI || target.startsWith(`${CLI}${sep}`);
}

function allowed({ file, specifier, typeOnly, dynamic }: Specifier): boolean {
  if (specifier.startsWith('.')) {
    return staysInside(file, specifier);
  }

  if (specifier.startsWith('node:') || LIBRARY_PACKAGES.has(specifier)) {
    return true;
  }

  return specifier === 'mailroll' && file.startsWith(`${CLI}${sep}`) && (typeOnly || dynamic);
}

describe('the @mailroll/outlook source', () => {
  it('imports only its own modules, Core, its two dependencies and Node.js; only the tool reaches mailroll', () => {
    const offenders = sourceFiles(SRC)
      .flatMap(specifiersOf)
      .filter((entry) => !allowed(entry))
      .map((entry) => `${relative(SRC, entry.file)}: ${entry.specifier}`);

    expect(offenders).toEqual([]);
  });

  it('keeps the library importable without mailroll: nothing outside src/cli mentions it or reaches src/cli', () => {
    const library = sourceFiles(SRC).filter((file) => !file.startsWith(`${CLI}${sep}`));
    const offenders = library
      .flatMap(specifiersOf)
      .filter(
        (entry) =>
          /^mailroll(\/|$)/.test(entry.specifier) ||
          (entry.specifier.startsWith('.') && reachesCli(entry.file, entry.specifier)),
      );

    expect(offenders).toEqual([]);
  });
});
