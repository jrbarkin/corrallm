import path from 'node:path';

import { app, BrowserWindow, dialog, powerMonitor, session } from 'electron';
import type { MessageBoxOptions } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import type { Answer } from '../shared/link';
import { APP_SCHEME, registerAppSchemePrivileges, serveAppScheme } from './app-protocol';
import { Closing } from './closing';
import { ProfileLocked } from './core/lock';
import type { CoreInit, CoreSide } from './core/protocol';
import { PROD_CSP } from './csp';
import { forkCore } from './host/core-process';
import { CorePorts } from './host/ports';
import { hostServices } from './host/services';
import { CoreSupervisor } from './host/supervisor';
import { startAppUpdates } from './host/updates';
import { registerIpcHandlers, sendEvent } from './ipc';
import { runNativeSelfTest } from './native-selftest';
import { RunShutdown } from './run-shutdown';
import { hardenSession, installNavigationGuards } from './security';
import { originKey } from './url-policy';
import { createMainWindow } from './window';
import type { AppUpdates } from './updates';

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

/** How long an explicit second-quit escape waits for the core to close. */
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
      /** Says why corrallm can't go on (in a dialog, unless hidden), then exits. */
      const refuse = (title: string, detail: string) => {
        console.error(`corrallm: ${detail}`);
        // The hidden e2e app shows nothing on screen, a dialog included.
        if (!hidden) dialog.showErrorBox(title, detail);
        app.exit(1);
      };
      const refuseLocked = (error: ProfileLocked) => {
        refuse(
          'corrallm can’t open its profile',
          `${error.message} ${
            error.holder === undefined
              ? 'Try again in a moment.'
              : 'Stop it (Ctrl-C where it runs), then open corrallm again.'
          }`,
        );
      };

      const shutdown = new RunShutdown((contents, requestId) => {
        sendEvent(contents, 'run:stopping', requestId);
      });
      const host = hostServices(shutdown);
      const init: CoreInit = {
        app: { name: app.getName(), version: app.getVersion() },
        profile: app.getPath('userData'),
        distribution: CORRALLM_DISTRIBUTION,
        locale: app.getLocale(),
        fakeSessions,
      };
      // The core owns the profile and its sessions; main answers only what needs the desktop. It
      // takes the profile (core.lock) as it comes up: `corrallm serve` may hold this one, and
      // must not write its stores while the app does. A core that crashes is restarted.
      const supervisor = new CoreSupervisor({
        fork: () =>
          forkCore({
            entry: path.join(__dirname, 'core.cjs'),
            output: (line, stream) => {
              if (stream === 'stdout') console.log(`[core] ${line}`);
              else console.error(`[core] ${line}`);
            },
            check: devServerUrl !== undefined,
            host,
          }),
        init: async (core) => {
          const up = await answered(core.link.request('init', init));
          if (up !== null) throw new ProfileLocked(up.profileLocked.holder ?? undefined);
        },
        restarting: (why) => {
          console.error(`corrallm: ${why}; starting it again.`);
        },
        restarted: () => {
          ports.reconnect();
        },
        gaveUp: (why) => {
          if (why instanceof ProfileLocked) {
            refuseLocked(why);
            return;
          }
          refuse(
            'corrallm’s core keeps stopping',
            `${why.message} Open corrallm again to go on from what was last saved.`,
          );
        },
      });
      const ports = new CorePorts(supervisor, trustedOrigin);
      try {
        await supervisor.start();
      } catch (error) {
        if (!(error instanceof ProfileLocked)) throw error;
        refuseLocked(error);
        return;
      }
      let updates: AppUpdates | undefined = undefined;
      app.once('will-quit', () => {
        updates?.stop();
        supervisor.stop();
      });
      /** Asks the core up now (waiting while a new one comes up), failing with its sentence. */
      const ask = async <K extends keyof CoreSide['requests']>(
        name: K,
        ...args: CoreSide['requests'][K]['args']
      ): Promise<CoreSide['requests'][K]['result']> =>
        answered((await supervisor.core).link.request(name, ...args));

      hardenSession(session.defaultSession, trustedOrigin);
      if (devServerUrl === undefined) {
        serveAppScheme({
          root: path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME),
          host: rendererHost,
          csp: PROD_CSP,
        });
      }
      registerIpcHandlers(trustedOrigin, ports);

      // Renderer acknowledgement precedes closing CLIs or flushing the profile's stores.
      const persistWindows = async (closing: BrowserWindow[]) => {
        const shown = await ask(
          'shown',
          closing.map((window) => window.webContents.id),
        );
        await Promise.all(
          closing.flatMap((window) =>
            shown.includes(window.webContents.id) ? [shutdown.stop(window.webContents)] : [],
          ),
        );
        await ask('flush');
      };
      // An approved quit waits for the complete core teardown. Only a second quit while
      // saving is stuck bounds that wait, as the user's explicit escape.
      let finishing: Promise<void> | undefined;
      let quitFailed = false;
      let readyToQuit = false;
      const failQuit = (why: string, error: unknown) => {
        const alreadyFailed = quitFailed;
        quitFailed = true;
        console.error(why, error);
        if (readyToQuit && !alreadyFailed) app.exit(1);
      };
      const abandon = (escape?: true) => (finishing ??= finish(escape));
      const finish = async (escape?: true) => {
        supervisor.stop();
        const closed = ask('close').catch((error: unknown) => {
          failQuit('Could not finish closing the core:', error);
        });
        if (!escape) {
          await closed;
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise((resolve) => {
              timer = setTimeout(resolve, ABANDON_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
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
          if (verb === 'Quit' && response !== 1) updates?.cancelRestart();
          return response === 1;
        };
      const quit = new Closing({
        save: async () => {
          await persistWindows(BrowserWindow.getAllWindows());
        },
        abandon,
        ask: askAnyway('Quit'),
        done: () => {
          void abandon().then(() => {
            readyToQuit = true;
            if (quitFailed) {
              app.exit(1);
              return;
            }
            // quitAndInstall closes windows before before-quit: call it only after saving and
            // core shutdown have been approved here, never straight from the update dialog.
            if (!updates?.finishQuit()) app.quit();
          });
        },
      });
      app.on('before-quit', (event) => {
        // Closing has approved the irreversible teardown, but a repeated native quit must
        // still wait until done() has finished closing the core.
        if (!quit.request() || !readyToQuit) event.preventDefault();
      });
      // A window gaining focus has the core check the file of the canvas it shows for a change on
      // disk (B9 Design §5): one made in another program while corrallm was in the background.
      app.on('browser-window-focus', (_event, window) => {
        supervisor.windowFocused(window.webContents.id);
      });
      powerMonitor.on('resume', () => {
        supervisor.resumed();
      });
      app.on('browser-window-created', (_event, window) => {
        // macOS window close does not quit the app, but must save/freeze the run all the same.
        const close = new Closing({
          save: () => persistWindows([window]),
          abandon: () => Promise.resolve(),
          ask: (why) =>
            // A window's earlier save can settle after the app has taken over shutdown. Its
            // result cannot reopen a dialog or turn that approved quit into a save failure.
            quit.approved ? Promise.resolve(false) : askAnyway('Close', window)(why),
          done: () => {
            if (!quit.approved) window.close();
          },
        });
        window.on('close', (event) => {
          if (quit.approved) {
            if (!readyToQuit) event.preventDefault();
            return;
          }
          // Quitting saves every window: a close meanwhile waits for it.
          if (quit.busy || !close.request()) event.preventDefault();
        });
      });

      try {
        await openMainWindow();
      } catch (error) {
        // Destroying a window mid-load rejects loadURL as ERR_ABORTED or ERR_FAILED. Only
        // an approved quit makes those expected; other startup errors still fail on stderr.
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (!quit.approved) throw error;
        if (code !== 'ERR_ABORTED' && code !== 'ERR_FAILED') {
          // Preserve the error exit, but still let the approved core teardown finish first.
          failQuit('Failed to start:', error);
        }
      }
      if (quit.approved) return;

      updates = startAppUpdates({
        requestQuit: () => {
          // A second quit while saving explicitly abandons it. An update instead joins it.
          if (!quit.busy && !quit.approved) app.quit();
        },
        openRelease: async (url) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window) throw new Error('There is no app window to open the release page.');
          await ask('openLink', window.webContents.id, url);
        },
      });

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
