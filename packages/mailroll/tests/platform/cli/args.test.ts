import { describe, expect, it } from 'vitest';
import { type SendOptionValues, selectionFromValues } from '../../../src/platform/cli/args';
import { CliError } from '../../../src/platform/cli/cli-error';

const base: SendOptionValues = { campaign: 'acme/newsletter', template: 'welcome', connection: 'outlook-1' };
const select = (values: SendOptionValues, env: NodeJS.ProcessEnv = {}) =>
  selectionFromValues({ ...base, ...values }, env);

describe('selectionFromValues', () => {
  it('builds a dry-run selection with several connections and previews', () => {
    const { selection, writePreviews, previewsDir } = select({
      connection: 'outlook-1,outlook-2',
      mode: 'dry-run',
      writePreviews: true,
    });

    expect(selection.connectionIds).toEqual(['outlook-1', 'outlook-2']);
    expect(selection.mode.kind).toBe('dry-run');
    expect(writePreviews).toBe(true);
    expect(previewsDir).toBe('previews');
  });

  it('uses the previews folder given with --previews-dir', () => {
    expect(select({ mode: 'dry-run', writePreviews: true, previewsDir: 'out' }).previewsDir).toBe('out');
  });

  it('expands --template × --data into one target per CSV', () => {
    const { selection } = select({ data: 'grupoA.csv,grupoB.csv', mode: 'dry-run' });

    expect(selection.targets).toEqual([
      { templateId: 'welcome', dataFile: 'grupoA.csv' },
      { templateId: 'welcome', dataFile: 'grupoB.csv' },
    ]);
  });

  it('defaults to a target without a data file when --data is absent', () => {
    expect(select({ mode: 'dry-run' }).selection.targets).toEqual([{ templateId: 'welcome' }]);
  });

  it('builds test mode with --to', () => {
    expect(select({ mode: 'test', to: 'qa@x.co' }).selection.mode).toEqual({ kind: 'test', testRecipient: 'qa@x.co' });
  });

  it('falls back to TEST_RECIPIENT when --to is absent in test mode', () => {
    expect(select({ mode: 'test' }, { TEST_RECIPIENT: 'qa@x.co' }).selection.mode).toEqual({
      kind: 'test',
      testRecipient: 'qa@x.co',
    });
  });

  it('prefers --to over TEST_RECIPIENT', () => {
    expect(select({ mode: 'test', to: 'explicit@x.co' }, { TEST_RECIPIENT: 'qa@x.co' }).selection.mode).toEqual({
      kind: 'test',
      testRecipient: 'explicit@x.co',
    });
  });

  it('errors in test mode when neither --to nor TEST_RECIPIENT is present', () => {
    expect(() => select({ mode: 'test' })).toThrow(CliError);
  });

  it('builds a subset policy', () => {
    const { selection } = select({ mode: 'dry-run', policy: 'subset', recipients: 'a@x.co,b@x.co' });

    expect(selection.policy).toEqual({ kind: 'subset', recipients: ['a@x.co', 'b@x.co'] });
  });

  it('reads one or several comma-separated --cc addresses', () => {
    expect(select({ mode: 'live', confirm: true, cc: 'a@x.co' }).selection.cc).toEqual(['a@x.co']);
    expect(select({ mode: 'dry-run', cc: 'a@x.co, b@x.co' }).selection.cc).toEqual(['a@x.co', 'b@x.co']);
  });

  it('de-duplicates --cc addresses case-insensitively (keeps the first spelling)', () => {
    expect(select({ mode: 'dry-run', cc: 'A@x.co,a@x.co,b@x.co' }).selection.cc).toEqual(['A@x.co', 'b@x.co']);
  });

  it('keeps an explicit empty --cc as "no CC"', () => {
    expect(select({ mode: 'dry-run', cc: '' }).selection.cc).toEqual([]);
  });

  it('errors on an invalid --cc address', () => {
    expect(() => select({ mode: 'dry-run', cc: 'not-an-email' })).toThrow(CliError);
  });

  it('does not read the CC from the environment (no --cc leaves it unset)', () => {
    expect(select({ mode: 'dry-run' }, { CC_RECIPIENT: 'env@x.co' }).selection.cc).toBeUndefined();
  });

  it('requires --confirm for live mode', () => {
    expect(() => select({ mode: 'live' })).toThrow(CliError);
  });

  it('errors on a missing required option', () => {
    expect(() => selectionFromValues({ template: 't', connection: 'x', mode: 'dry-run' }, {})).toThrow(CliError);
  });

  it.each<[SendOptionValues, string]>([
    [{ mode: 'live', confirm: true, recipients: 'one@x.co' }, '--recipients only applies to --policy subset'],
    [{ mode: 'dry-run', to: 'qa@x.co' }, '--to only applies to --mode test'],
    [{ mode: 'dry-run', confirm: true }, '--confirm only applies to --mode live'],
    [{ mode: 'live', confirm: true, writePreviews: true }, '--write-previews only applies to --mode dry-run'],
    [{ mode: 'dry-run', previewsDir: 'out' }, '--previews-dir only applies to --write-previews'],
    [{ mode: 'dry-run', writePreviews: true, previewsDir: ' ' }, '--previews-dir needs a folder name'],
  ])('rejects an option that does not apply instead of ignoring it: %j', (extra, message) => {
    expect(() => select(extra)).toThrow(message);
    expect(() => select(extra)).toThrow(CliError);
  });

  it('names the field and the reason when an address is rejected', () => {
    expect(() => select({ mode: 'test', to: 'qa@' })).toThrow(
      'invalid test recipient "qa@": email is not a valid address (it needs exactly one @ between a name and a domain)',
    );
    expect(() => select({ mode: 'dry-run', policy: 'subset', recipients: 'ok@x.co,bad address@x.co' })).toThrow(
      'invalid --recipients address "bad address@x.co": email contains spaces, control or invisible characters',
    );
    expect(() => select({ mode: 'dry-run', cc: 'a@b.c' })).toThrow(
      'invalid CC address "a@b.c": email is not a valid address (invalid domain)',
    );
  });

  it('reports selection problems as usage errors (exit code 2)', () => {
    expect(() => selectionFromValues({ ...base, template: ',', mode: 'dry-run' }, {})).toThrow(CliError);
  });
});
