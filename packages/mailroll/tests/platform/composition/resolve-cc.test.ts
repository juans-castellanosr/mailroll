import { describe, expect, it } from 'vitest';
import { ConfigError, type EmailAddress, parseEmailAddress, type RunMode } from '@mailroll/core';
import { resolveCc } from '../../../src/platform/composition/resolve-cc';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

const cc = [addr('coordinacion@x.co'), addr('decano@x.co')];
const live: RunMode = { kind: 'live' };
const dry: RunMode = { kind: 'dry-run' };

describe('resolveCc', () => {
  it('forbidden: rejects any CC and always returns an empty list', () => {
    expect(() => resolveCc('forbidden', cc, dry, 'welcome-mail')).toThrow(ConfigError);
    expect(resolveCc('forbidden', undefined, live, 'welcome-mail')).toEqual([]);
    expect(resolveCc('forbidden', [], live, 'welcome-mail')).toEqual([]);
  });

  it('required: blocks a live send with no CC (undefined or empty)', () => {
    expect(() => resolveCc('required', undefined, live, 'feedback-rubric')).toThrow(ConfigError);
    expect(() => resolveCc('required', [], live, 'feedback-rubric')).toThrow(ConfigError);
    expect(resolveCc('required', cc, live, 'feedback-rubric')).toEqual(cc);
  });

  it('required: allows dry-run without a CC (optional there) and passes a list through', () => {
    expect(resolveCc('required', undefined, dry, 'feedback-rubric')).toEqual([]);
    expect(resolveCc('required', cc, dry, 'feedback-rubric')).toEqual(cc);
  });
});
