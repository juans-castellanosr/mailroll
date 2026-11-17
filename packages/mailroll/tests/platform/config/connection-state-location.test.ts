import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionStateLocation } from 'mailroll';

describe('the state location the host gives each connection', () => {
  it.each([
    [{}, 'acme/onboarding', 'outlook-1', join('.secrets/tokens', 'acme_onboarding'), 'outlook_1'],
    [{}, 'g/c', 'outlook_1', join('.secrets/tokens', 'g_c'), 'outlook_1'],
    [{}, 'Ünïcode Group/c.v2', 'Out look-1', join('.secrets/tokens', 'n_code_Group_c_v2'), 'Out_look_1'],
    [
      { TOKEN_CACHE_PATH: '/var/tokens' },
      'acme/onboarding',
      'outlook-1',
      join('/var/tokens', 'acme_onboarding'),
      'outlook_1',
    ],
    [
      { TOKEN_CACHE_PATH: '/var/tokens' },
      'Ünïcode Group/c.v2',
      'Out look-1',
      join('/var/tokens', 'n_code_Group_c_v2'),
      'Out_look_1',
    ],
  ])(
    'keeps the location used before M3 for %o, campaign %s, connection %s',
    (env, campaignId, connectionId, stateDirectory, stateKey) => {
      expect(connectionStateLocation({ env, campaignId, connectionId })).toEqual({ stateDirectory, stateKey });
    },
  );
});
