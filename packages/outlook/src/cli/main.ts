#!/usr/bin/env node
import { isatty } from 'node:tty';
import { createCliOutput } from './cli-output';
import { loadInstalledMailroll } from './host';
import { EXIT, runOutlookCli } from './program';

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
  const argv = process.argv.slice(2);

  if (argv.includes('--no-color')) {
    process.env['NO_COLOR'] = '1';
    process.env['FORCE_COLOR'] = '0';
  }

  const out = createCliOutput(process);

  try {
    loadDotEnv();
  } catch (error) {
    out.error(`cannot read .env: ${error instanceof Error ? error.message : 'unknown error'}`);

    return EXIT.usage;
  }

  return runOutlookCli(argv, {
    out,
    env: process.env,
    interactive: isatty(0) && isatty(2),
    writeOut: (text) => process.stdout.write(text),
    loadHost: loadInstalledMailroll,
  });
}

process.exitCode = await main();
