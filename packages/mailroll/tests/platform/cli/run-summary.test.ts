import { describe, expect, it } from 'vitest';
import type { SendSelection } from '@mailroll/core';
import { summaryJson } from '../../../src/platform/cli/run-summary';
import type { TemplateRunResult } from '../../../src/platform/composition/build-runner';

const selection: SendSelection = {
  campaignId: 'acme/onboarding',
  targets: [{ templateId: 'welcome' }],
  connectionIds: ['outlook-1'],
  policy: { kind: 'pending' },
  mode: { kind: 'live' },
};

const clean: TemplateRunResult = {
  templateId: 'welcome',
  dataFile: 'recipients.csv',
  policy: 'pending',
  statePath: 'state.json',
  history: { before: 'v2', upgraded: false },
  report: {
    total: 1,
    sent: 1,
    failed: 0,
    uncertain: 0,
    notAttempted: 0,
    skipped: 0,
    heldUncertain: 0,
    ccRejectedMessages: 0,
    requiredCcRejectedMessages: 0,
    results: [],
  },
};

describe('summaryJson', () => {
  it('needs no attention when every list finished cleanly', () => {
    expect(summaryJson(selection, [clean])).toMatchObject({ needsAttention: false });
    expect(summaryJson(selection, [clean])).not.toHaveProperty('interrupted');
  });

  it('marks a stopped run as needing attention and names the lists that never ran', () => {
    const summary = summaryJson(selection, [clean], {
      reason: 'disk full',
      notRun: [{ templateId: 'reminder', dataFile: 'recipients.csv' }],
    });

    expect(summary).toMatchObject({
      needsAttention: true,
      interrupted: { reason: 'disk full', notRun: [{ templateId: 'reminder', dataFile: 'recipients.csv' }] },
    });
  });
});
