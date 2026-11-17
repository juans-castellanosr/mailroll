import { styleText } from 'node:util';
import { toSafeJson } from '../terminal/safe-json';
import { forTerminal } from '../terminal/terminal-text';

export type Tone = 'success' | 'warning' | 'error' | 'muted' | 'strong';

const STYLE: Readonly<Record<Tone, Parameters<typeof styleText>[0]>> = {
  success: 'green',
  warning: 'yellow',
  error: 'red',
  muted: 'dim',
  strong: 'bold',
};

export interface Styled {
  readonly tone: Tone;
  readonly text: string;
}
export type Segment = string | Styled;

export function styled(tone: Tone, text: string): Styled {
  return { tone, text };
}

export interface Output {
  data(...segments: readonly Segment[]): void;
  json(value: unknown): void;
  info(...segments: readonly Segment[]): void;
  warn(...segments: readonly Segment[]): void;
  error(...segments: readonly Segment[]): void;
}

interface Streams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export function createOutput(streams: Streams = process): Output {
  const line =
    (stream: NodeJS.WritableStream, prefix?: Styled) =>
    (...segments: readonly Segment[]): void => {
      const parts = prefix !== undefined ? [prefix, ' ', ...segments] : segments;

      stream.write(`${parts.map((segment) => render(stream, segment)).join('')}\n`);
    };

  return {
    data: line(streams.stdout),
    json: (value) => {
      streams.stdout.write(`${toSafeJson(value, 2)}\n`);
    },
    info: line(streams.stderr),
    warn: line(streams.stderr, styled('warning', 'warning:')),
    error: line(streams.stderr, styled('error', 'error:')),
  };
}

function render(stream: NodeJS.WritableStream, segment: Segment): string {
  if (typeof segment === 'string') {
    return forTerminal(segment);
  }

  return styleText(STYLE[segment.tone], forTerminal(segment.text), { stream });
}
