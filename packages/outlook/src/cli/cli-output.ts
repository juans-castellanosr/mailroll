import { styleText } from 'node:util';

const UNSAFE = /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]/gu;

export interface CliOutput {
  info(text: string): void;
  error(text: string): void;
}

export interface CliStreams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export function forTerminal(text: string): string {
  return text.replace(UNSAFE, (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`);
}

export function createCliOutput(streams: CliStreams): CliOutput {
  return {
    info: (text) => {
      streams.stderr.write(`${forTerminal(text)}\n`);
    },
    error: (text) => {
      streams.stderr.write(`${styleText('red', 'error:', { stream: streams.stderr })} ${forTerminal(text)}\n`);
    },
  };
}
