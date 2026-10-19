import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

const { hooks, launchApp } = vi.hoisted(() => ({
  hooks: {
    before: undefined as (() => Promise<void>) | undefined,
    after: undefined as (() => Promise<void>) | undefined,
  },
  launchApp: vi.fn<(options: { profile: string }) => Promise<never>>(),
}));
vi.mock('@playwright/test', async () => ({
  expect: (await import('vitest')).expect,
  test: Object.assign(() => undefined, {
    skip: () => undefined,
    beforeEach: (run: () => Promise<void>) => {
      hooks.before = run;
    },
    afterEach: (run: () => Promise<void>) => {
      hooks.after = run;
    },
  }),
}));
vi.mock('../../e2e/launch', () => ({ launchApp }));

it('keeps the original app-server launch failure without a second error from cleanup', async () => {
  const failed = new Error('electron.launch: Process failed to launch!');
  launchApp.mockRejectedValue(failed);
  await import('../../e2e/app-server.e2e');
  if (!hooks.before || !hooks.after) throw new Error('No app-server setup and cleanup.');
  try {
    await expect(hooks.before()).rejects.toBe(failed);
    await expect(hooks.after()).resolves.toBeUndefined();
    const profile = launchApp.mock.calls[0]?.[0].profile;
    if (!profile) throw new Error('No launch was attempted.');
    expect(existsSync(path.dirname(profile))).toBe(false);
  } finally {
    const profile = launchApp.mock.calls[0]?.[0].profile;
    if (profile) await rm(path.dirname(profile), { recursive: true, force: true });
  }
});
