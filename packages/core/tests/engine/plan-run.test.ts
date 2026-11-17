import { describe, expect, it } from 'vitest';
import { type EmailAddress, parseEmailAddress } from '../../src/domain/addressing/email-address';
import type { RecipientStatus, TemplateState } from '../../src/domain/run/template-state';
import { planRun } from '../../src/engine/plan-run';

function addr(value: string): EmailAddress {
  const outcome = parseEmailAddress(value);

  if (!outcome.ok) {
    throw new Error('test setup: bad email');
  }

  return outcome.value;
}

const A = addr('a@x.co');
const B = addr('b@x.co');
const C = addr('c@x.co');

function state(recipients: Record<string, RecipientStatus>): TemplateState {
  return { version: 2, templateId: 't', recipients, updatedAt: '1970-01-01T00:00:00.000Z' };
}

const known = state({
  'a@x.co': { status: 'sent', at: 't', connectionId: 'x' },
  'b@x.co': { status: 'failed', at: 't', connectionId: 'x', category: 'permanent', message: 'm' },
});
const D = addr('d@x.co');

describe('planRun', () => {
  it('pending sends the not-yet-sent and reports already-sent as skipped', () => {
    const plan = planRun({ recipients: [A, B, C], state: known, policy: { kind: 'pending' }, connectionIds: ['x'] });

    expect(plan.assignments.map((a) => a.recipient)).toEqual([B, C]);
    expect(plan.skipped.map((s) => s.identifier)).toEqual([A]);
  });

  it('failed-only sends only prior failures', () => {
    const plan = planRun({
      recipients: [A, B, C],
      state: known,
      policy: { kind: 'failed-only' },
      connectionIds: ['x'],
    });

    expect(plan.assignments.map((a) => a.recipient)).toEqual([B]);
    expect(plan.skipped.map((s) => s.identifier)).toEqual([A, C]);
  });

  it('force-all sends everyone with no skips', () => {
    const plan = planRun({ recipients: [A, B, C], state: known, policy: { kind: 'force-all' }, connectionIds: ['x'] });

    expect(plan.assignments.map((a) => a.recipient)).toEqual([A, B, C]);
    expect(plan.skipped).toEqual([]);
  });

  it('subset sends the requested recipients that are valid', () => {
    const plan = planRun({
      recipients: [A, B, C],
      state: known,
      policy: { kind: 'subset', recipients: [C, addr('unknown@x.co')] },
      connectionIds: ['x'],
    });

    expect(plan.assignments.map((a) => a.recipient)).toEqual([C]);
    expect(plan.skipped.map((s) => [s.identifier, s.reasons[0]])).toEqual([
      [A, 'not selected (subset policy)'],
      [B, 'not selected (subset policy)'],
      ['unknown@x.co', 'requested, but not in this list (or rejected by the template validator)'],
    ]);
  });

  it('pending never resends an uncertain recipient; force-all does', () => {
    const withUncertain = state({
      'd@x.co': { status: 'uncertain', at: 't', connectionId: 'x', message: 'timeout' },
    });
    const pending = planRun({
      recipients: [C, D],
      state: withUncertain,
      policy: { kind: 'pending' },
      connectionIds: ['x'],
    });

    expect(pending.assignments.map((a) => a.recipient)).toEqual([C]);
    expect(pending.skipped[0]?.reasons[0]).toMatch(/uncertain/);

    const force = planRun({
      recipients: [C, D],
      state: withUncertain,
      policy: { kind: 'force-all' },
      connectionIds: ['x'],
    });

    expect(force.assignments.map((a) => a.recipient)).toEqual([C, D]);
  });
});
