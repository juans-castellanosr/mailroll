import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { handleInterrupts } from '../../../src/platform/cli/interrupt';

function setup() {
  const source = new EventEmitter();
  const calls: string[] = [];
  const stop = handleInterrupts(source, {
    onFirst: () => calls.push('first'),
    onSecond: () => calls.push('second'),
  });

  return { source, calls, stop };
}

describe('handleInterrupts', () => {
  it('stops gracefully on the first Ctrl-C and quits on the second', () => {
    const { source, calls } = setup();

    source.emit('SIGINT');
    source.emit('SIGINT');

    expect(calls).toEqual(['first', 'second']);
  });

  it('leaves no listener behind once the run is over, after one Ctrl-C or none', () => {
    const interrupted = setup();

    interrupted.source.emit('SIGINT');
    interrupted.stop();

    const untouched = setup();

    untouched.stop();

    expect(interrupted.source.listenerCount('SIGINT')).toBe(0);
    expect(untouched.source.listenerCount('SIGINT')).toBe(0);
    expect(interrupted.calls).toEqual(['first']);
  });
});
