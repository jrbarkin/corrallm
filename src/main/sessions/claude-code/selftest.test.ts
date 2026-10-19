import { describe, expect, it } from 'vitest';

import { checkAgentSdk } from './selftest';

describe('the Agent SDK native self-test', () => {
  it('starts an Agent SDK query on its own fake claude, and hears its result', async () => {
    await expect(checkAgentSdk()).resolves.toBe('Agent SDK ok (the fake claude said “ok”)');
  });

  it('fails when the fake claude cannot run', async () => {
    await expect(checkAgentSdk({ PATH: '/nowhere' })).rejects.toThrow();
  });
});
