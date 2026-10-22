import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app, autoUpdater, dialog } from 'electron';

import { AppUpdates } from '../updates';
import type { UpdateBackend } from '../updates';

const execute = promisify(execFile);

export interface AppUpdateActions {
  requestQuit: () => void;
  openRelease: (url: string) => Promise<void>;
}

/** Runtime inspection also catches an ad hoc package launched without its build-time env. */
export async function hasUpdateSignature(
  executable: string,
  run: (file: string, args: string[]) => Promise<{ stderr: string }> = (file, args) =>
    execute(file, args, { timeout: 5000 }),
): Promise<boolean> {
  try {
    const { stderr } = await run('/usr/bin/codesign', ['--display', '--verbose=4', executable]);
    return (
      /^Authority=Developer ID Application:/m.test(stderr) && !/^Signature=adhoc$/m.test(stderr)
    );
  } catch {
    return false;
  }
}

/** Electron is confined to the host; policy, clocks and network are injected into AppUpdates. */
export function startAppUpdates(actions: AppUpdateActions): AppUpdates {
  const backend: UpdateBackend = {
    setFeedURL: (options) => {
      autoUpdater.setFeedURL(options);
    },
    checkForUpdates: () => {
      autoUpdater.checkForUpdates();
    },
    quitAndInstall: () => {
      autoUpdater.quitAndInstall();
    },
    listen: (events) => {
      const error = (why: Error) => {
        events.error(why);
      };
      const settled = () => {
        events.settled();
      };
      const downloaded = (_event: Electron.Event, _notes: string, name: string) => {
        events.downloaded(name);
      };
      autoUpdater.on('error', error);
      autoUpdater.on('update-not-available', settled);
      autoUpdater.on('update-downloaded', downloaded);
      return () => {
        autoUpdater.removeListener('error', error);
        autoUpdater.removeListener('update-not-available', settled);
        autoUpdater.removeListener('update-downloaded', downloaded);
      };
    },
  };
  const updates = new AppUpdates({
    ...actions,
    updater: backend,
    packaged: app.isPackaged,
    development: MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined,
    selfTest: process.env.CORRALLM_NATIVE_SELFTEST === '1',
    disabled: process.env.CORRALLM_NO_UPDATE_CHECK === '1',
    unsigned: process.env.CORRALLM_UNSIGNED === '1',
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    signedMac: () => hasUpdateSignature(app.getPath('exe')),
    fetch: (url, options) => fetch(url, options),
    prompt: async (options) =>
      (await dialog.showMessageBox({ type: 'info', noLink: true, ...options })).response,
    log: (message) => {
      console.error(`corrallm: ${message}`);
    },
  });
  void updates.start();
  return updates;
}
