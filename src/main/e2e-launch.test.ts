import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => vi.fn(() => 'linux'));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform,
}));

const launch = vi.hoisted(() =>
  vi.fn<
    (options: {
      chromiumSandbox?: boolean;
      args?: string[];
      env?: Record<string, string | undefined>;
    }) => Promise<unknown>
  >(() => Promise.resolve({ process: () => ({ exitCode: 0 }), close: vi.fn() })),
);
vi.mock('@playwright/test', () => ({ _electron: { launch } }));
vi.mock('../../e2e/agent-electron', () => ({ agentElectronExecutable: () => undefined }));

import { launchApp } from '../../e2e/launch';

beforeEach(() => {
  vi.clearAllMocks();
  platform.mockReturnValue('linux');
  vi.stubEnv('CORRALLM_E2E_GL', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('keeps Chromium sandboxing enabled (including Linux) and defaults to no real agent CLIs', async () => {
  const { close } = await launchApp({ profile: '/test-profile-not-created' });
  // Assert only these fields: a failed assertion must never print the host's environment.
  const options = launch.mock.calls[0]?.[0];
  expect(options?.chromiumSandbox).toBe(true);
  expect(options?.env?.CORRALLM_AGENT_PATHS).toBe('{}');
  await close();
});

it('selects Mesa through ANGLE only for the opted-in Linux test launch', async () => {
  vi.stubEnv('CORRALLM_E2E_GL', 'mesa');
  const { close } = await launchApp({ profile: '/test-profile-not-created', args: ['--test'] });
  const options = launch.mock.calls[0]?.[0];
  expect(options?.args).toEqual([
    '--use-gl=angle',
    '--use-angle=gl',
    '--ignore-gpu-blocklist',
    '--ozone-platform=x11',
    '.',
    '--user-data-dir=/test-profile-not-created',
    '--test',
  ]);
  expect(options?.chromiumSandbox).toBe(true);
  await close();
});

it.each([
  ['linux', undefined],
  ['linux', 'other'],
  ['darwin', 'mesa'],
  ['win32', 'mesa'],
])('adds no graphics switches on %s with the opt-in %s', async (os, setting) => {
  platform.mockReturnValue(os);
  vi.stubEnv('CORRALLM_E2E_GL', setting);
  const { close } = await launchApp({ profile: '/test-profile-not-created' });
  expect(launch.mock.calls[0]?.[0].args).toEqual([
    '.',
    '--user-data-dir=/test-profile-not-created',
  ]);
  await close();
});
