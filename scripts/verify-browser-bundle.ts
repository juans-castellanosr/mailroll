import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const BUDGET_BYTES = 34.5 * 1024;

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function packageRootOf(file: string): string {
  let dir = dirname(file);

  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);

    if (parent === dir) {
      throw new Error(`${file} is not inside a package`);
    }

    dir = parent;
  }

  return dir;
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
}

function allowedDistDirectories(root: string, manifest: Manifest): readonly string[] {
  const requireFromPackage = createRequire(join(root, 'package.json'));
  const workspaceRoots = Object.entries(manifest.dependencies ?? {})
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => dirname(realpathSync(requireFromPackage.resolve(`${name}/package.json`))));

  return [realpathSync(root), ...workspaceRoots].map((dir) => `${join(dir, 'dist')}${sep}`);
}

const [entryArgument] = process.argv.slice(2);

if (entryArgument === undefined) {
  throw new Error('usage: node scripts/verify-browser-bundle.ts <built-entry.mjs>');
}

const entry = resolve(entryArgument);

if (!existsSync(entry)) {
  throw new Error(`${entry} not found: run "pnpm run build" first`);
}

const root = packageRootOf(entry);
const manifest = readManifest(root);
const label = `${manifest.name} (${relative(root, entry)})`;
const allowed = allowedDistDirectories(root, manifest);

const result = await build({
  absWorkingDir: root,
  tsconfigRaw: {},
  entryPoints: [entry],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
  metafile: true,
  logLevel: 'silent',
});

const inputs = Object.keys(result.metafile.inputs);
const foreign = inputs.filter((input) => {
  const path = realpathSync(resolve(root, input));

  return !allowed.some((dir) => path.startsWith(dir));
});

if (foreign.length > 0) {
  throw new Error(
    `${label} pulls in modules outside its own and its workspace dependencies' builds: ${foreign.join(', ')}`,
  );
}

const bytes = result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0);

if (bytes > BUDGET_BYTES) {
  throw new Error(`${label} is ${String(bytes)} bytes minified, over its ${String(BUDGET_BYTES)}-byte budget`);
}

process.stdout.write(
  `${label} bundles for the browser: ${String(bytes)} bytes minified, ${String(inputs.length)} inputs, no Node or third-party modules.\n`,
);
