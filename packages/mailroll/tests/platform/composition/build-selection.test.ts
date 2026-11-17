import { describe, expect, it } from 'vitest';
import { ConfigError } from '@mailroll/core';
import { buildSelection, type RawSelection } from '../../../src/platform/composition/build-selection';

const base: RawSelection = {
  campaignId: 'acme/newsletter',
  targets: [{ templateId: 'welcome' }],
  connectionIds: ['outlook-1'],
  policy: { kind: 'pending' },
  mode: { kind: 'dry-run' },
};

describe('buildSelection', () => {
  it('dedupes targets and connection ids', () => {
    const selection = buildSelection({
      ...base,
      targets: [{ templateId: 'a' }, { templateId: 'a' }, { templateId: 'b' }],
      connectionIds: ['x', 'x'],
    });

    expect(selection.targets).toEqual([{ templateId: 'a' }, { templateId: 'b' }]);
    expect(selection.connectionIds).toEqual(['x']);
  });

  it('keeps the same template paired with different CSVs as distinct targets', () => {
    const selection = buildSelection({
      ...base,
      targets: [
        { templateId: 'a', dataFile: 'x.csv' },
        { templateId: 'a', dataFile: 'y.csv' },
        { templateId: 'a', dataFile: 'x.csv' },
      ],
    });

    expect(selection.targets).toEqual([
      { templateId: 'a', dataFile: 'x.csv' },
      { templateId: 'a', dataFile: 'y.csv' },
    ]);
  });

  it('requires at least one target and connection', () => {
    expect(() => buildSelection({ ...base, targets: [] })).toThrow(ConfigError);
    expect(() => buildSelection({ ...base, connectionIds: [] })).toThrow(ConfigError);
  });

  it('subset policy requires recipients', () => {
    expect(() => buildSelection({ ...base, policy: { kind: 'subset', recipients: [] } })).toThrow(ConfigError);
  });

  it('a per-target subset policy also requires recipients', () => {
    expect(() =>
      buildSelection({
        ...base,
        targets: [{ templateId: 'a', policy: { kind: 'subset', recipients: [] } }],
      }),
    ).toThrow(ConfigError);
  });
});
