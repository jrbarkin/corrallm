import path from 'node:path';

import { app, BrowserWindow, dialog, session } from 'electron';
import type { MessageBoxOptions } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import type { Answer } from '../shared/link';
import { APP_SCHEME, registerAppSchemePrivileges, serveAppScheme } from './app-protocol';
import { Closing } from './closing';
import { ProfileLocked } from './core/lock';
import { PROD_CSP } from './csp';
import { forkCore } from './host/core-process';
import { CorePorts } from './host/ports';
import { hostServices } from './host/services';
import { registerIpcHandlers, sendEvent } from './ipc';
import { runNativeSelfTest } from './native-selftest';
import { RunShutdown } from './run-shutdown';
import { hardenSession, installNavigationGuards } from './security';
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

/** How long closing without saving waits for the agents' sessions to end. */
const ABANDON_MS = 5000;

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

  // Only one instance may write this profile's state or resume its agents' conversations.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // e2e tests (e2e/launch.ts) run the unpackaged app with its window hidden, and connected
  // sessions with fake connectors. Never in packaged builds.
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
      const shutdown = new RunShutdown((contents, requestId) => {
        sendEvent(contents, 'run:stopping', requestId);
      });
      // The core owns the profile and its sessions; main answers only what needs the desktop. It
      // takes the profile (core.lock) as it comes up: `corrallm serve` may hold this one, and
      // must not write its stores while the app does.
      const core = forkCore({
        entry: path.join(__dirname, 'core.cjs'),
        output: (line, stream) => {
          if (stream === 'stdout') console.log(`[core] ${line}`);
          else console.error(`[core] ${line}`);
        },
        check: devServerUrl !== undefined,
        host: hostServices(shutdown),
      });
      const up = await answered(
        core.link.request('init', {
          app: { name: app.getName(), version: app.getVersion() },
          profile: app.getPath('userData'),
          distribution: CORRALLM_DISTRIBUTION,
          locale: app.getLocale(),
          fakeSessions,
        }),
      );
      if (up !== null) {
        const { holder } = up.profileLocked;
        const detail = `${new ProfileLocked(holder ?? undefined).message} ${
          holder === null
            ? 'Try again in a moment.'
            : 'Stop it (Ctrl-C where it runs), then open corrallm again.'
        }`;
        console.error(`corrallm: ${detail}`);
        // The hidden e2e app shows nothing on screen, a dialog included.
        if (!hidden) dialog.showErrorBox('corrallm can’t open its profile', detail);
        app.exit(1);
        return;
      }

      hardenSession(session.defaultSession, trustedOrigin);
      if (devServerUrl === undefined) {
        serveAppScheme({
          root: path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME),
          host: rendererHost,
          csp: PROD_CSP,
        });
      }
      registerIpcHandlers(trustedOrigin, new CorePorts(core, trustedOrigin));

      // Renderer acknowledgement precedes closing CLIs or flushing the profile's stores.
      const persistWindows = async (closing: BrowserWindow[]) => {
        const shown = await answered(
          core.link.request(
            'shown',
            closing.map((window) => window.webContents.id),
          ),
        );
        await Promise.all(
          closing.flatMap((window) =>
            shown.includes(window.webContents.id) ? [shutdown.stop(window.webContents)] : [],
          ),
        );
        await answered(core.link.request('flush'));
      };
      // Closing without saving, after the user said to: give the core a few seconds to finish.
      const abandon = async () => {
        await Promise.race([
          core.link.request('close').catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, ABANDON_MS)),
        ]);
      };
      const askAnyway =
        (verb: 'Quit' | 'Close', window?: BrowserWindow) =>
        async (why: string): Promise<boolean> => {
          console.error('Could not save before closing:', why);
          if (hidden) {
            await abandon();
            app.exit(1);
            return false;
          }
          const options: MessageBoxOptions = {
            type: 'warning',
            message: 'The run could not be saved',
            detail: `${why}\n\n${verb} anyway? What wasn't saved is lost, and the agents' sessions end.`,
            buttons: ['Keep corrallm open', `${verb} anyway`],
            defaultId: 0,
            cancelId: 0,
          };
          const { response } = await (window
            ? dialog.showMessageBox(window, options)
            : dialog.showMessageBox(options));
          return response === 1;
        };
      const quit = new Closing({
        save: async () => {
          await persistWindows(BrowserWindow.getAllWindows());
          await answered(core.link.request('close'));
        },
        abandon,
        ask: askAnyway('Quit'),
        done: () => {
          app.quit();
        },
      });
      app.on('before-quit', (event) => {
        if (!quit.request()) event.preventDefault();
      });
      app.on('browser-window-created', (_event, window) => {
        // macOS window close does not quit the app, but must save/freeze the run all the same.
        const close = new Closing({
          save: () => persistWindows([window]),
          abandon,
          ask: askAnyway('Close', window),
          done: () => {
            window.close();
          },
        });
        window.on('close', (event) => {
          if (quit.approved) return;
          // Quitting saves every window: a close meanwhile waits for it.
          if (quit.busy || !close.request()) event.preventDefault();
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

/** A failed core request must stop a save/close, with its sentence intact. */
async function answered<T>(asked: Promise<Answer<T>>): Promise<T> {
  const answer = await asked;
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value;
}

main();
