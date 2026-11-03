import { expect, it } from 'vitest';

import { NO_BACKEND } from './receive';

it('a disconnected session backend refuses starts without owning installation discovery', async () => {
  expect(NO_BACKEND).not.toHaveProperty('installed');
  await expect(
    NO_BACKEND.start('agent', { connection: 'unfamiliar.console', model: null, mode: null }),
  ).rejects.toThrow('Connected sessions run only in the corrallm app.');
});
