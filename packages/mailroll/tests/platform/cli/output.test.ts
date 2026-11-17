import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutput, styled } from '../../../src/platform/cli/output';

const ESC = String.fromCharCode(27);

function capture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const read = (stream: PassThrough): string => (stream.read() as Buffer | null)?.toString('utf8') ?? '';

  return { out: createOutput({ stdout, stderr }), stdout: () => read(stdout), stderr: () => read(stderr) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createOutput', () => {
  it('sends data to stdout and messages to stderr', () => {
    const io = capture();

    io.out.data('result');
    io.out.info('progress');
    io.out.warn('careful');
    io.out.error('broken');

    expect(io.stdout()).toBe('result\n');
    expect(io.stderr()).toBe('progress\nwarning: careful\nerror: broken\n');
  });

  it('escapes control characters coming from data, also inside styled text', () => {
    const io = capture();

    io.out.data(`name${ESC}[2J`, styled('strong', `id${ESC}]0;x`));
    expect(io.stdout()).toBe('name\\u{1b}[2Jid\\u{1b}]0;x\n');
  });

  it("keeps its own color codes when color is on, while still escaping the data's", () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const io = capture();

    io.out.data(styled('strong', `id${ESC}[2J`));
    expect(io.stdout()).toBe(`${ESC}[1mid\\u{1b}[2J${ESC}[22m\n`);
  });

  it('uses no color codes when NO_COLOR-style settings turn color off', () => {
    vi.stubEnv('FORCE_COLOR', '0');
    const io = capture();

    io.out.warn('careful');
    expect(io.stderr()).toBe('warning: careful\n');
  });
});
