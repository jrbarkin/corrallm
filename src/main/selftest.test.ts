import { describe, expect, it } from 'vitest';

import { checkAgentSdk, checkTerminalScreen } from './selftest';

/*
 * The packaged self-test's checks, run here as they run in the packaged app (native-selftest.ts),
 * so that a change to the Agent SDK's protocol or to the terminal's screen breaks them here first.
 */

describe('the packaged app’s self-test', () => {
  it('finds main’s copy of a terminal screen working', async () => {
    await expect(checkTerminalScreen()).resolves.toBe('@xterm/headless ok (40×5)');
  });

  it('starts an Agent SDK query on its own fake claude, and hears its result', async () => {
    await expect(checkAgentSdk()).resolves.toBe('Agent SDK ok (the fake claude said “ok”)');
  });

  it('fails when the fake claude cannot run', async () => {
    await expect(checkAgentSdk({ PATH: '/nowhere' })).rejects.toThrow();
  });
});
