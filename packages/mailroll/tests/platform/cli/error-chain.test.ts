import { describe, expect, it } from 'vitest';
import { AuthError, SignInRequiredError } from '@mailroll/core';
import { describeError, findInChain, isPromptExit } from '../../../src/platform/cli/error-chain';

describe('error chain helpers', () => {
  it('shows each distinct cause once, skipping causes already quoted by their wrapper', () => {
    const disk = new Error('ENOSPC: no space left on device');
    const wrapped = new Error(`run stopped: ${disk.message}`, { cause: disk });
    const outer = new Error('run stopped after 0 of 1 list(s)', { cause: wrapped });

    expect(describeError(outer)).toBe(
      'run stopped after 0 of 1 list(s)\n  caused by: run stopped: ENOSPC: no space left on device',
    );
  });

  it('finds a typed error anywhere in the cause chain', () => {
    const signIn = new SignInRequiredError('no saved sign-in');
    const wrapped = new AuthError('authentication failed', { cause: signIn });

    expect(findInChain(wrapped, SignInRequiredError)).toBe(signIn);
    expect(findInChain(new Error('other'), SignInRequiredError)).toBeUndefined();
  });

  it('recognizes a prompt closed with Ctrl-C', () => {
    const closed = new Error('User force closed the prompt');

    closed.name = 'ExitPromptError';

    expect(isPromptExit(closed)).toBe(true);
    expect(isPromptExit(new Error('boom'))).toBe(false);
  });
});
