#!/usr/bin/env node
import { isatty } from 'node:tty';
import { EXIT } from './context';
import { createOutput } from './output';
import { runCli } from './program';
import { loadIntegrationsDeclaredIn } from './project-integrations';

function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

async function main(): Promise<number> {
  const out = createOutput();

  try {
    loadDotEnv();
  } catch (error) {
    out.error(`cannot read .env: ${error instanceof Error ? error.message : 'unknown error'}`);

    return EXIT.usage;
  }

  return runCli(process.argv.slice(2), {
    out,
    env: process.env,
    interactive: isatty(0) && isatty(2),
    cwd: process.cwd(),
    loadIntegrations: loadIntegrationsDeclaredIn,
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
}

process.exitCode = await main();
