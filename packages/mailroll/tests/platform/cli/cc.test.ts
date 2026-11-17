import { describe, expect, it } from 'vitest';
import { type CcPrompts, parseCcList, resolveCcInteractive } from '../../../src/platform/cli/cc';
import { CliError } from '../../../src/platform/cli/cli-error';

function prompts(picked: readonly string[], typed: string): CcPrompts {
  return {
    pickFromList: () => Promise.resolve(picked),
    addNew: () => Promise.resolve(typed),
  };
}

describe('parseCcList', () => {
  it('parses a single address', () => {
    expect(parseCcList('a@x.co')).toEqual(['a@x.co']);
  });

  it('parses several comma-separated addresses', () => {
    expect(parseCcList('a@x.co, b@x.co')).toEqual(['a@x.co', 'b@x.co']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(parseCcList('A@x.co, a@x.co, b@x.co')).toEqual(['A@x.co', 'b@x.co']);
  });

  it('throws CliError on an invalid address', () => {
    expect(() => parseCcList('a@x.co, nope')).toThrow(CliError);
  });

  it('yields an empty list for a blank string', () => {
    expect(parseCcList('  ,  ')).toEqual([]);
  });
});

describe('resolveCcInteractive', () => {
  const saved = { envRaw: 'saved1@x.co,saved2@x.co', required: false };

  it('selects one saved address', async () => {
    const cc = await resolveCcInteractive({ ...saved, prompts: prompts(['saved1@x.co'], '') });

    expect(cc).toEqual(['saved1@x.co']);
  });

  it('selects several saved addresses', async () => {
    const cc = await resolveCcInteractive({
      ...saved,
      prompts: prompts(['saved1@x.co', 'saved2@x.co'], ''),
    });

    expect(cc).toEqual(['saved1@x.co', 'saved2@x.co']);
  });

  it('accepts a newly typed address', async () => {
    const cc = await resolveCcInteractive({ ...saved, prompts: prompts([], 'new@x.co') });

    expect(cc).toEqual(['new@x.co']);
  });

  it('combines saved selections and new addresses in one step', async () => {
    const cc = await resolveCcInteractive({
      ...saved,
      prompts: prompts(['saved1@x.co'], 'new@x.co, new2@x.co'),
    });

    expect(cc).toEqual(['saved1@x.co', 'new@x.co', 'new2@x.co']);
  });

  it('de-duplicates across saved and new addresses (case-insensitive)', async () => {
    const cc = await resolveCcInteractive({
      ...saved,
      prompts: prompts(['saved1@x.co'], 'SAVED1@x.co, new@x.co'),
    });

    expect(cc).toEqual(['saved1@x.co', 'new@x.co']);
  });

  it('throws CliError on an invalid typed address', async () => {
    await expect(resolveCcInteractive({ ...saved, prompts: prompts([], 'nope') })).rejects.toThrow(CliError);
  });

  it('errors when a CC is required but nothing is chosen', async () => {
    await expect(
      resolveCcInteractive({
        envRaw: 'saved1@x.co',
        required: true,
        prompts: prompts([], ''),
      }),
    ).rejects.toThrow(CliError);
  });

  it('offers the current CC first and pre-ticked, merged with the saved addresses', async () => {
    const seen: string[][] = [];
    const cc = await resolveCcInteractive({
      ...saved,
      current: parseCcList('cur@x.co, saved2@x.co'),
      prompts: {
        pickFromList: (choices, checked) => {
          seen.push([...choices], [...checked]);

          return Promise.resolve(['cur@x.co']);
        },
        addNew: () => Promise.resolve(''),
      },
    });

    expect(seen).toEqual([
      ['cur@x.co', 'saved2@x.co', 'saved1@x.co'],
      ['cur@x.co', 'saved2@x.co'],
    ]);
    expect(cc).toEqual(['cur@x.co']);
  });

  it('returns an empty list when optional and nothing is chosen', async () => {
    const cc = await resolveCcInteractive({ ...saved, prompts: prompts([], '') });

    expect(cc).toEqual([]);
  });
});
