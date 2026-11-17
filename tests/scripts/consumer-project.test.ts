import { describe, expect, it } from 'vitest';
import { captureNode, windowsCommandLine } from '../../scripts/consumer-project.ts';

describe('the package verification helper', () => {
  it('passes empty arguments and arguments with spaces to Node.js intact', () => {
    const echoed = captureNode(
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '', 'a b', '--json'],
      {},
    );

    expect(JSON.parse(echoed)).toEqual(['', 'a b', '--json']);
  });

  it('quotes every part of a Windows package-manager command line, including empty ones', () => {
    expect(windowsCommandLine('pnpm', ['install', '', 'C:\\Users\\Ana Ruiz\\store', 'say "hi"'])).toBe(
      '"pnpm" "install" "" "C:\\Users\\Ana Ruiz\\store" "say ""hi"""',
    );
  });
});
