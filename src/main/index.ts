import path from 'node:path';

import { app, BrowserWindow, session } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import { APP_SCHEME, registerAppSchemePrivileges, serveAppScheme } from './app-protocol';
import { PROD_CSP } from './csp';
import { registerIpcHandlers } from './ipc';
import { runNativeSelfTest } from './native-selftest';
import { hardenSession, installNavigationGuards } from './security';
import { originKey } from './url-policy';
import { createMainWindow } from './window';

// Defined only under `electron-forge start`. Production builds (packaged or not) serve the
// renderer from app://, so dev-only relaxations key off this rather than app.isPackaged.
const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const rendererHost = MAIN_WINDOW_VITE_NAME.toLowerCase();

function main(): void {
  // Squirrel.Windows launches the app with --squirrel-* flags on install/update/uninstall.
  if (squirrelStartup) {
    app.quit();
    return;
  }

  // No fuse covers Chromium's remote-debugging switches, so refuse them in packaged builds.
  if (
    app.isPackaged &&
    (app.commandLine.hasSwitch('remote-debugging-port') ||
      app.commandLine.hasSwitch('remote-debugging-pipe'))
  ) {
    app.exit(1);
    return;
  }

  if (process.env.CORRALLM_NATIVE_SELFTEST === '1') {
    void app.whenReady().then(runNativeSelfTest);
    return;
  }

  const trustedOrigin =
    devServerUrl === undefined ? `${APP_SCHEME}://${rendererHost}` : originKey(devServerUrl);
  if (trustedOrigin === null) throw new Error(`Invalid dev server URL: ${String(devServerUrl)}`);
  const rendererUrl = devServerUrl ?? `${APP_SCHEME}://${rendererHost}/index.html`;

  registerAppSchemePrivileges();
  app.enableSandbox();
  installNavigationGuards(trustedOrigin);

  const openMainWindow = () => createMainWindow(rendererUrl, { devTools: !app.isPackaged });

  void app
    .whenReady()
    .then(async () => {
      hardenSession(session.defaultSession, trustedOrigin);
      if (devServerUrl === undefined) {
        serveAppScheme({
          root: path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME),
          host: rendererHost,
          csp: PROD_CSP,
        });
      }
      registerIpcHandlers(trustedOrigin);
      await openMainWindow();

      // macOS: re-create a window when the dock icon is clicked and none are open.
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
      });
    })
    .catch((error: unknown) => {
      console.error('Failed to start:', error);
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

main();
