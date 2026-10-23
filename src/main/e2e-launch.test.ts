import { expect, it, vi } from 'vitest';

const launch = vi.hoisted(() =>
  vi.fn<
    (options: {
      chromiumSandbox?: boolean;
      env?: Record<string, string | undefined>;
    }) => Promise<unknown>
  >(() => Promise.resolve({ process: () => ({ exitCode: 0 }), close: vi.fn() })),
);
vi.mock('@playwright/test', () => ({ _electron: { launch } }));
vi.mock('../../e2e/agent-electron', () => ({ agentElectronExecutable: () => undefined }));

import { launchApp } from '../../e2e/launch';

it('keeps Chromium sandboxing enabled (including Linux) and defaults to no real agent CLIs', async () => {
  const { close } = await launchApp({ profile: '/test-profile-not-created' });
  // Assert only these fields: a failed assertion must never print the host's environment.
  const options = launch.mock.calls[0]?.[0];
  expect(options?.chromiumSandbox).toBe(true);
  expect(options?.env?.CORRALLM_AGENT_PATHS).toBe('{}');
  await close();
});
