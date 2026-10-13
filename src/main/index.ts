import path from 'node:path';

import { app, BrowserWindow, session } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import { APP_SCHEME, registerAppSchemePrivileges, serveAppScheme } from './app-protocol';
import { canvasFile } from './canvas';
import { PROD_CSP } from './csp';
import { ProjectFiles } from './files';
import { registerIpcHandlers, sendEvent } from './ipc';
import { CanvasMemory } from './memory';
import { runNativeSelfTest } from './native-selftest';
import { ProjectFolders } from './project';
import { hardenSession, installNavigationGuards } from './security';
import { createConnectors } from './sessions/connectors';
import { agentEnvironment, loginShellEnvironment } from './sessions/environment';
import { SessionManager } from './sessions/manager';
import { originKey } from './url-policy';
import { createMainWindow } from './window';

// Defined only under `electron-forge start`. Production builds (packaged or not) serve the
// renderer from app://, so dev-only relaxations key off this rather than app.isPackaged.
const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const rendererHost = MAIN_WINDOW_VITE_NAME.toLowerCase();

// Chromium switches no fuse covers: they expose the DevTools protocol or make the app launch an
// arbitrary executable as its own child process. Packaged builds refuse to start with them.
// (Linux's --zygote-cmd-prefix acts before any JS runs and cannot be blocked here.)
const FORBIDDEN_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'renderer-cmd-prefix',
  'gpu-launcher',
  'utility-cmd-prefix',
  'browser-subprocess-path',
] as const;

function main(): void {
  // Squirrel.Windows launches the app with --squirrel-* flags on install/update/uninstall.
  if (squirrelStartup) {
    app.quit();
    return;
  }

  if (app.isPackaged && FORBIDDEN_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) {
    app.exit(1);
    return;
  }

  if (process.env.CORRALLM_NATIVE_SELFTEST === '1') {
    void app.whenReady().then(runNativeSelfTest);
    return;
  }

  // e2e tests (e2e/launch.ts) run the unpackaged app with its window hidden, and connected
  // sessions with a fake connector instead of Claude Code. Never in packaged builds.
  const hidden = !app.isPackaged && process.env.CORRALLM_HIDE_WINDOW === '1';
  const fakeSessions = !app.isPackaged && process.env.CORRALLM_FAKE_SESSIONS === '1';
  // On macOS, also no Dock icon or menu bar, from the start rather than once the app is ready.
  if (hidden && process.platform === 'darwin') app.setActivationPolicy('accessory');

  // TODO(auto-update): call updateElectronApp() (update-electron-app) here when app.isPackaged.
  // Works with the Squirrel.Windows and macOS ZIP makers; needs published releases and a
  // Developer ID-signed macOS build. Linux deb/rpm updates come from the package manager.

  const trustedOrigin =
    devServerUrl === undefined ? `${APP_SCHEME}://${rendererHost}` : originKey(devServerUrl);
  if (trustedOrigin === null) throw new Error(`Invalid dev server URL: ${String(devServerUrl)}`);
  const rendererUrl = devServerUrl ?? `${APP_SCHEME}://${rendererHost}/index.html`;

  registerAppSchemePrivileges();
  app.enableSandbox();
  installNavigationGuards(trustedOrigin);

  const openMainWindow = () => createMainWindow(rendererUrl, { devTools: !app.isPackaged, hidden });

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
      // What main remembers of canvas files, their project folders, and their agents' sessions.
      const memory = new CanvasMemory(path.join(app.getPath('userData'), 'canvases.json'));
      const projects = new ProjectFolders(memory, canvasFile);
      let environment: Promise<Record<string, string>> | undefined;
      // Resolved once, when the first session starts.
      const agentsEnvironment = () =>
        (environment ??= fakeSessions
          ? Promise.resolve(agentEnvironment(process.env))
          : loginShellEnvironment().then(agentEnvironment));
      const sessions = new SessionManager({
        connectors: createConnectors({
          fake: fakeSessions,
          clientApp: `${app.getName()}/${app.getVersion()}`,
        }),
        environment: agentsEnvironment,
        projectOf: (contents) => projects.of(contents),
        canvasOf: canvasFile,
        memory,
        emit: (contents, agentId, connection, event) => {
          sendEvent(contents, 'session:event', agentId, connection, event);
        },
        terminal: (contents, agentId, event) => {
          sendEvent(contents, 'terminal:event', agentId, event);
        },
      });
      const files = new ProjectFiles({ environment: agentsEnvironment });
      registerIpcHandlers(trustedOrigin, { projects, files, sessions });

      // Every agent's process ends before the app does, and what main remembers is written.
      let quitting = false;
      app.on('before-quit', (event) => {
        if (quitting) return;
        quitting = true;
        event.preventDefault();
        void Promise.all([sessions.closeEverything(), memory.flush()]).finally(() => {
          app.quit();
        });
      });

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
