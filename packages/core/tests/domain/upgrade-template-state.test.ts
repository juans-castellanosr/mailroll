import { describe, expect, it } from 'vitest';
import { type TemplateState, type TemplateStateV1, upgradeTemplateState } from '../../src/domain/run/template-state';

const V1: TemplateStateV1 = {
  version: 1,
  templateId: 't',
  recipients: {
    'a@x.co': {
      status: 'sent',
      at: 'T0',
      connectionId: 'x',
      resendFailure: { at: 'T1', connectionId: 'x', outcome: 'failed', message: 'm', category: 'permanent' },
    },
    'b@x.co': { status: 'failed', at: 'T0', connectionId: 'x', category: 'transient', message: 'm' },
    'c@x.co': { status: 'uncertain', at: 'T0', connectionId: 'x', message: 'm' },
  },
  updatedAt: 'T1',
};

describe('upgradeTemplateState', () => {
  it('copies a v1 state exactly, changing only its version', () => {
    expect(upgradeTemplateState(V1)).toEqual({ ...V1, version: 2 });
  });

  it('adds no evidence that v1 never recorded', () => {
    const text = JSON.stringify(upgradeTemplateState(V1));

    expect(text).not.toMatch(/attemptId|providerMessageId|"cc"|uncertainAttemptIds/);
  });

  it('returns a v2 state as it is', () => {
    const v2: TemplateState = { ...V1, version: 2 };

    expect(upgradeTemplateState(v2)).toBe(v2);
  });

  it('leaves the v1 state it was given unchanged', () => {
    const frozen = Object.freeze({ ...V1 });

    upgradeTemplateState(frozen);

    expect(frozen.version).toBe(1);
  });
});
