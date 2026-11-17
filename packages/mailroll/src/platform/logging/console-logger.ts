import { toSafeJson } from '../terminal/safe-json';
import type { LogFields, Logger, LogValue } from '@mailroll/core';

export type LogLevel = 'info' | 'warn' | 'error';
const RANK: Readonly<Record<LogLevel, number>> = { info: 0, warn: 1, error: 2 };
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(password|secret|token|authorization|credential|html|content)/i;

export interface ConsoleLoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: (line: string) => void;
}

export class ConsoleLogger implements Logger {
  private readonly minimum: number;
  private readonly sink: (line: string) => void;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.minimum = RANK[options.level ?? 'info'];
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  }

  info(event: string, fields?: LogFields): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.emit('error', event, fields);
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (RANK[level] < this.minimum) {
      return;
    }

    this.sink(toSafeJson({ time: new Date().toISOString(), level, event, ...this.redact(fields) }));
  }

  private redact(fields?: LogFields): Record<string, LogValue> {
    const out: Record<string, LogValue> = {};

    if (fields === undefined) {
      return out;
    }

    for (const [key, value] of Object.entries(fields)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : value;
    }

    return out;
  }
}
