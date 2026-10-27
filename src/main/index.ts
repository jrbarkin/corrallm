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
import { registerIpcHandlers } from './ipc';
import { runNativeSelfTest } from './native-selftest';
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
  // macOS stays up as ever; elsewhere, until the core is up, the last window closing quits.
  let lastWindowClosed = () => {
    app.quit();
  };

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
            // corrallm token holds a profile only while it writes the profile's tokens.
            error.holder === undefined || error.holder.owner === 'token'
              ? 'Try again in a moment.'
              : 'Stop it (Ctrl-C where it runs), then open corrallm again.'
          }`,
        );
      };

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
      const supervisor: CoreSupervisor = new CoreSupervisor({
        fork: () =>
          forkCore({
            entry: path.join(__dirname, 'core.cjs'),
            output: (line, stream) => {
              if (stream === 'stdout') console.log(`[core] ${line}`);
              else console.error(`[core] ${line}`);
            },
            check: devServerUrl !== undefined,
            host: (core) => hostServices(core, (source) => supervisor.owns(source)),
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

      /**
       * Each window finishes the drafts it composes, over its own port, at most DRAFTS_MS each (a
       * crashed one is skipped): rejects, for the failed-save dialog, if one didn't.
       */
      const flushDrafts = async (closing: BrowserWindow[]) => {
        const { unanswered } = await ask(
          'flushDrafts',
          closing.map((window) => window.webContents.id),
        );
        if (unanswered.length > 0) {
          throw new Error(
            unanswered.length === 1
              ? 'A window did not finish saving what was being typed in it before closing'
              : `${String(unanswered.length)} windows did not finish saving what was being typed in them before closing`,
          );
        }
      };
      // An approved quit waits for the complete core teardown. Only a second quit, while
      // saving or the core's close is stuck, bounds that wait, as the user's explicit escape.
      let finishing: Promise<void> | undefined;
      let quitFailed = false;
      let readyToQuit = false;
      const failQuit = (why: string, error: unknown) => {
        const alreadyFailed = quitFailed;
        quitFailed = true;
        console.error(why, error);
        if (readyToQuit && !alreadyFailed) app.exit(1);
      };
      const escaped = Promise.withResolvers<undefined>();
      let escapeTimer: ReturnType<typeof setTimeout> | undefined;
      const abandon = (escape?: true) => {
        finishing ??= finish();
        if (escape && !readyToQuit) {
          escapeTimer ??= setTimeout(() => {
            escaped.resolve(undefined);
          }, ABANDON_MS);
        }
        return finishing;
      };
      const finish = async () => {
        supervisor.stop();
        // The shutdown barrier committed: the endpoint closes, then every session and the stores.
        const closed = ask('commitShutdown').catch((error: unknown) => {
          failQuit('Could not finish closing the core:', error);
        });
        try {
          await Promise.race([closed, escaped.promise]);
        } finally {
          clearTimeout(escapeTimer);
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
            // A window only views its canvas: closing it ends no session (B11 Design §8).
            detail:
              verb === 'Quit'
                ? `${why}\n\nQuit anyway? What wasn't saved is lost, and the agents' sessions end.`
                : `${why}\n\nClose anyway? What wasn't saved is lost; the agents go on working.`,
            buttons: ['Keep corrallm open', `${verb} anyway`],
            defaultId: 0,
            cancelId: 0,
          };
          const { response } = await (window
            ? dialog.showMessageBox(window, options)
            : dialog.showMessageBox(options));
          if (verb === 'Quit' && response !== 1) {
            updates?.cancelRestart();
            // Keep corrallm open: the barrier lifts, and the endpoint and every turn go on.
            await ask('cancelShutdown').catch((error: unknown) => {
              console.error('Could not keep the core going:', error);
            });
          }
          return response === 1;
        };
      const quit = new Closing({
        // The drafts each window composes, then the core's barrier: no new dispatch or write,
        // everything forced to disk, sessions still usable. Every run is the core's (B11 §8).
        save: async () => {
          await flushDrafts(BrowserWindow.getAllWindows());
          const prepared = await ask(
            'prepareShutdown',
            updates?.restarting === true ? 'update' : 'quit',
          );
          if ('failed' in prepared) throw new Error(prepared.sentence);
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
        // still wait until done() has finished closing the core: it gives that close only the
        // escape's last few seconds, as the way out of one that hangs.
        const closing = quit.approved && !readyToQuit;
        if (!quit.request() || !readyToQuit) event.preventDefault();
        if (closing) void abandon(true);
      });
      // A window gaining focus has the core check the file of the canvas it shows for a change on
      // disk (B9 Design §5): one made in another program while corrallm was in the background.
      app.on('browser-window-focus', (_event, window) => {
        supervisor.windowFocused(window.webContents.id);
      });
      powerMonitor.on('resume', () => {
        supervisor.resumed();
      });
      /** Shows a window again (B11 Design §8): the first open one, focused, else a new one. */
      const reopen = () => {
        if (quit.busy || quit.approved) return;
        const [shown] = BrowserWindow.getAllWindows();
        if (shown === undefined) {
          void openMainWindow().catch((error: unknown) => {
            console.error('Could not open corrallm’s window:', error);
          });
          return;
        }
        if (shown.isMinimized()) shown.restore();
        if (!hidden) shown.show();
        shown.focus();
      };
      // Opening corrallm again while it runs (the single instance's lock) shows its window: the
      // way back to one closed while the core kept working, on every platform.
      app.on('second-instance', reopen);
      // Windows and Linux: the last window closing quits, unless the core has work going on
      // (a turn, a running run, a job): then it runs on, and opening corrallm again shows it. The
      // core decides in one step, holding its barrier only if nothing is at work (B14 C2's
      // ifIdle), so work starting meanwhile is never cut off unasked. C4 replaces this with the
      // run-aware question.
      lastWindowClosed = () => {
        if (quit.busy || quit.approved) return;
        void ask('prepareShutdown', 'quit', { ifIdle: true }).then(
          (prepared) => {
            const idle = !('busy' in prepared);
            if (BrowserWindow.getAllWindows().length > 0 || quit.busy || quit.approved) {
              // A window came back meanwhile: the barrier held for this close lifts.
              if (idle && !quit.busy && !quit.approved) {
                void ask('cancelShutdown').catch((error: unknown) => {
                  console.error('Could not keep the core going:', error);
                });
              }
              return;
            }
            if (idle) {
              app.quit();
              return;
            }
            console.error(
              'corrallm: its agents are still working, so it runs on with no window: open corrallm again to show it, and quit it there.',
            );
          },
          () => {
            app.quit();
          },
        );
      };
      app.on('browser-window-created', (_event, window) => {
        // A window closing only finishes the drafts it composes: its canvas runs on in the core,
        // which a window only views (B11 Design §8). macOS stays up as ever.
        const close = new Closing({
          save: () => flushDrafts([window]),
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
    if (process.platform !== 'darwin') lastWindowClosed();
  });
}

/** A failed core request must stop a save/close, with its sentence intact. */
async function answered<T>(asked: Promise<Answer<T>>): Promise<T> {
  const answer = await asked;
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value;
}

main();
