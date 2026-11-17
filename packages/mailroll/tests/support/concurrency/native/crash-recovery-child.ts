import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

type Operation = (...args: unknown[]) => Promise<unknown>;

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises') as Record<'open' | 'rename' | 'link' | 'rm', Operation>;
const lockPath = process.env['LOCK_PATH'] ?? '';
const lockModule = process.env['LOCK_MODULE'] ?? '';
const crashAt = Number(process.env['CRASH_AT'] ?? 'NaN');
let operations = 0;

for (const name of ['open', 'rename', 'link', 'rm'] as const) {
  const original = fsPromises[name];

  fsPromises[name] = (...args: unknown[]): Promise<unknown> => {
    operations += 1;

    if (operations === crashAt) {
      process.stdout.write(`crashing before ${name} ${String(args[0])}\n`);
      process.kill(process.pid, 'SIGKILL');
    }

    return original(...args);
  };
}

syncBuiltinESMExports();

const { acquireFileLock } = (await import(pathToFileURL(lockModule).href)) as {
  readonly acquireFileLock: (path: string, describe: string) => Promise<unknown>;
};

try {
  await acquireFileLock(lockPath, 'the list');
  process.stdout.write(`acquired after ${String(operations)} operations\n`);
} catch (error) {
  process.stdout.write(`refused: ${error instanceof Error ? error.message : String(error)}\n`);
}
