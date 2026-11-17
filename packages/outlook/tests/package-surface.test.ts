import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SENDER_CONTRACT, validateIntegrationDescriptor } from '@mailroll/core';
import * as outlook from '@mailroll/outlook';
import { OUTLOOK_VERSION } from '../src/version';

const PACKAGE = resolve(import.meta.dirname, '..');

const RUNTIME_EXPORTS = [
  'GraphClient',
  'OUTLOOK_INTEGRATION_ID',
  'OutlookAuthProvider',
  'OutlookProviderFactory',
  'SentItemsReader',
  'createOutlookIntegration',
  'default',
  'outlookIntegration',
  'outlookTokenCachePath',
];

describe('the @mailroll/outlook package surface', () => {
  it('exports the Outlook descriptor by default, and it passes the public validation', () => {
    const checked = validateIntegrationDescriptor(outlook.default);

    expect(checked.ok).toBe(true);
    expect(outlook.default).toBe(outlook.outlookIntegration);
    expect(outlook.default).toMatchObject({ id: 'outlook', roles: { sender: { contract: SENDER_CONTRACT } } });
  });

  it('carries the version of its package.json', () => {
    const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { version: string };

    expect(OUTLOOK_VERSION).toBe(version);
    expect(outlook.default.version).toBe(version);
  });

  it('exports exactly the runtime API that moved out of mailroll, plus the descriptor and its helpers', () => {
    expect(Object.keys(outlook).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });
});
