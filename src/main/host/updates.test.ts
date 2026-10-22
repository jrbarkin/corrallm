import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  app: { isPackaged: false, getVersion: () => '1.2.3', getPath: () => '/App/corrallm' },
  events: new Map<string, (...args: unknown[]) => void>(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
  dialog: vi.fn(),
}));
vi.mock('electron', () => ({
  app: fakes.app,
  autoUpdater: {
    on: (name: string, listener: (...args: unknown[]) => void) => {
      fakes.events.set(name, listener);
    },
    removeListener: (name: string) => {
      fakes.events.delete(name);
    },
    setFeedURL: fakes.setFeedURL,
    checkForUpdates: fakes.checkForUpdates,
    quitAndInstall: fakes.quitAndInstall,
  },
  dialog: { showMessageBox: fakes.dialog },
}));

import { hasUpdateSignature, startAppUpdates } from './updates';

beforeEach(() => {
  vi.clearAllMocks();
  fakes.events.clear();
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  fakes.app.isPackaged = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('recognizes Developer ID signing and refuses ad hoc, development or absent signatures', async () => {
  const run = vi.fn(() =>
    Promise.resolve({ stderr: 'Authority=Developer ID Application: Example (1234)\n' }),
  );
  await expect(hasUpdateSignature('/My.app/Contents/MacOS/corrallm', run)).resolves.toBe(true);
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    '/My.app/Contents/MacOS/corrallm',
  ]);
  for (const stderr of ['Signature=adhoc\n', 'Authority=Apple Development: Example\n', '']) {
    run.mockResolvedValueOnce({ stderr });
    await expect(hasUpdateSignature('/app', run)).resolves.toBe(false);
  }
  run.mockRejectedValueOnce(new Error('Not signed'));
  await expect(hasUpdateSignature('/app', run)).resolves.toBe(false);
});

it.each(['unpackaged', 'dev', 'CORRALLM_NO_UPDATE_CHECK', 'CORRALLM_NATIVE_SELFTEST'])(
  'does not touch the native updater, dialog or network: %s',
  async (why) => {
    fakes.app.isPackaged = why !== 'unpackaged';
    if (why === 'dev') vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
    else if (why !== 'unpackaged') vi.stubEnv(why, '1');
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network in a unit test'));
    const actions = { requestQuit: vi.fn(), openRelease: vi.fn(() => Promise.resolve()) };
    const updates = startAppUpdates(actions);
    await updates.start();
    expect(fakes.setFeedURL).not.toHaveBeenCalled();
    expect(fakes.checkForUpdates).not.toHaveBeenCalled();
    expect(fakes.dialog).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(fakes.events.size).toBe(0);
    updates.stop();
    network.mockRestore();
  },
);
