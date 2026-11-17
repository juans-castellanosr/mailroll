import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureNode, windowsCommandLine } from '../../scripts/consumer-project.ts';

const LAUNCHED_ARGUMENTS = ['', 'a b', 'say "hi"', '""', 'a&echo injected', 'a|b', '(a)', 'C:\\Users\\Ana Ruiz\\store'];

interface LauncherWorkspace {
  readonly launcherDir: string;
  readonly consumerDir: string;
  readonly env: NodeJS.ProcessEnv;
}

function withLauncherOnPath(use: (workspace: LauncherWorkspace) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'mailroll launcher '));
  const launcherDir = join(base, 'launcher dir');
  const consumerDir = join(base, 'consumer dir');

  try {
    mkdirSync(launcherDir);
    mkdirSync(consumerDir);
    writeFileSync(
      join(launcherDir, 'probe.js'),
      'process.stdout.write(JSON.stringify({ dir: __dirname, argv: process.argv.slice(2) }));\nprocess.exitCode = Number(process.env.PROBE_EXIT ?? 0);\n',
    );
    writeFileSync(
      join(launcherDir, 'mailroll-probe.cmd'),
      `@ECHO OFF\r\n"${process.execPath}" "%~dp0probe.js" %*\r\nEXIT /B %ERRORLEVEL%\r\n`,
    );

    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

    use({
      launcherDir,
      consumerDir,
      env: { ...process.env, [pathKey]: `${launcherDir};${process.env[pathKey] ?? ''}` },
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function launched(output: string): { readonly dir: string; readonly argv: readonly string[] } {
  return JSON.parse(output) as { readonly dir: string; readonly argv: readonly string[] };
}

describe('the package verification helper', () => {
  it('passes empty arguments and arguments with spaces to Node.js intact', () => {
    const echoed = captureNode(
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '', 'a b', '--json'],
      {},
    );

    expect(JSON.parse(echoed)).toEqual(['', 'a b', '--json']);
  });

  it('quotes every argument of a Windows package-manager command line, including empty ones, but not the command name', () => {
    expect(windowsCommandLine('pnpm', ['install', '', 'C:\\Users\\Ana Ruiz\\store', 'say "hi"'])).toBe(
      'pnpm "install" "" "C:\\Users\\Ana Ruiz\\store" "say ""hi"""',
    );
  });

  it.each(['', 'npm & calc', 'C:\\tools\\npm', '"npm"'])('refuses %j as a Windows command name', (command) => {
    expect(() => windowsCommandLine(command, ['install'])).toThrow(/only a bare command name found on PATH is allowed/);
  });

  it.runIf(process.platform === 'win32')(
    'runs a launcher found on PATH from its own folder, with its arguments intact, as the harness runs npm',
    () => {
      withLauncherOnPath(({ launcherDir, consumerDir, env }) => {
        const output = execSync(windowsCommandLine('mailroll-probe', LAUNCHED_ARGUMENTS), {
          cwd: consumerDir,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        expect(launched(output)).toEqual({ dir: launcherDir, argv: LAUNCHED_ARGUMENTS });
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'runs a launcher found on PATH through a shell and reports its exit code, as the harness runs package binaries',
    () => {
      withLauncherOnPath(({ launcherDir, consumerDir, env }) => {
        const result = spawnSync(windowsCommandLine('mailroll-probe', LAUNCHED_ARGUMENTS), {
          cwd: consumerDir,
          env: { ...env, PROBE_EXIT: '7' },
          shell: true,
          encoding: 'utf8',
        });

        expect(result.status).toBe(7);
        expect(launched(result.stdout)).toEqual({ dir: launcherDir, argv: LAUNCHED_ARGUMENTS });
      });
    },
  );
});
