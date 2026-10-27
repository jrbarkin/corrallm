import path from 'node:path';

import { app, BrowserWindow, dialog, powerMonitor, session } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import type { Answer } from '../shared/link';
import { APP_SCHEME, registerAppSchemePrivileges, serveAppScheme } from './app-protocol';
import { ProfileLocked } from './core/lock';
import type { CoreInit, CoreSide } from './core/protocol';
import { PROD_CSP } from './csp';
import { QuitCoordinator } from './host/closing';
import { forkCore } from './host/core-process';
import { CorePorts } from './host/ports';
import { hostServices } from './host/services';
import { CoreSupervisor } from './host/supervisor';
import { startAppUpdates } from './host/updates';
import { electronNotifications, electronPresence } from './host/electron-presence';
import { NativeNotifications, nativePresentation } from './host/notifications';
import { PresencePresentation } from './host/presence';
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
  if (process.platform === 'linux') app.setDesktopName('corrallm.desktop');

  const trustedOrigin =
    devServerUrl === undefined ? `${APP_SCHEME}://${rendererHost}` : originKey(devServerUrl);
  if (trustedOrigin === null) throw new Error(`Invalid dev server URL: ${String(devServerUrl)}`);
  const rendererUrl = devServerUrl ?? `${APP_SCHEME}://${rendererHost}/index.html`;

  registerAppSchemePrivileges();
  app.enableSandbox();
  installNavigationGuards(trustedOrigin);

  const openMainWindow = () => createMainWindow(rendererUrl, { devTools: !app.isPackaged, hidden });
  // macOS stays up as ever; elsewhere, until the quit coordinator is there, the last window
  // closing quits (Electron's own default, kept: no window exists before then).
  let allClosed = () => {
    if (process.platform !== 'darwin') app.quit();
  };
  let disposePresence = () => {
    /* No native presentation is allocated before ready. */
  };

  void app
    .whenReady()
    .then(async () => {
      /** Says why corrallm can't go on (in a dialog, unless hidden), then exits. */
      const refuse = (title: string, detail: string) => {
        console.error(`corrallm: ${detail}`);
        // The hidden e2e app shows nothing on screen, a dialog included.
        if (!hidden) dialog.showErrorBox(title, detail);
        disposePresence();
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
      let updates: AppUpdates | undefined = undefined;
      const notifications = new Set<NativeNotifications>();
      // One native presenter per main process, even when the core is replaced.
      const notificationBackend = electronNotifications(process.platform);
      // The core owns the profile and its sessions; main answers only what needs the desktop. It
      // takes the profile (core.lock) as it comes up: `corrallm serve` may hold this one, and
      // must not write its stores while the app does. A core that crashes is restarted; one that
      // closes itself (a signal: it says `exiting`, or exits 0 unasked) takes main through the
      // system's path (B14 C4), so main never sits with no core.
      const supervisor: CoreSupervisor = new CoreSupervisor({
        fork: () => {
          const core = forkCore({
            entry: path.join(__dirname, 'core.cjs'),
            output: (line, stream) => {
              if (stream === 'stdout') console.log(`[core] ${line}`);
              else console.error(`[core] ${line}`);
            },
            check: devServerUrl !== undefined,
            host: (forked) => {
              const native = new NativeNotifications({
                hidden,
                backend: notificationBackend,
                focused: () => BrowserWindow.getFocusedWindow() !== null,
                current: () => supervisor.owns(forked) && !quit.approved,
                activate: (handle) => quit.activate(handle),
                log: (message) => {
                  console.error(message);
                },
              });
              notifications.add(native);
              void forked.exited.then(() => {
                native.close();
                notifications.delete(native);
              });
              // C9's trusted cue is the core's own presence (§9.w): the first snapshot with an agent
              // working while the core's notifications are on. The OS is asked then, and (the backend
              // checking once per process) never again for a replacement core.
              return hostServices(
                forked,
                (source) => supervisor.owns(source),
                nativePresentation(native),
              );
            },
          });
          core.link.on('presence', () => {
            if (supervisor.owns(core)) nativePresence.update(supervisor.presence);
          });
          core.link.on('exiting', () => {
            if (supervisor.owns(core)) quit.request('system');
          });
          return core;
        },
        init: async (core) => {
          const up = await answered(core.link.request('init', init));
          if (up !== null) throw new ProfileLocked(up.profileLocked.holder ?? undefined);
          core.focus(BrowserWindow.getFocusedWindow() !== null);
        },
        restarting: (why) => {
          nativePresence.update(undefined);
          console.error(`corrallm: ${why}; starting it again.`);
        },
        restarted: () => {
          ports.reconnect();
        },
        gaveUp: (why) => {
          nativePresence.update(undefined);
          if (why instanceof ProfileLocked) {
            refuseLocked(why);
            return;
          }
          refuse(
            'corrallm’s core keeps stopping',
            `${why.message} Open corrallm again to go on from what was last saved.`,
          );
        },
        closedItself: () => {
          nativePresence.update(undefined);
          quit.request('system');
        },
      });
      const ports = new CorePorts(supervisor, trustedOrigin);
      /** Asks the core up now (waiting while a new one comes up), failing with its sentence. */
      const ask = async <K extends keyof CoreSide['requests']>(
        name: K,
        ...args: CoreSide['requests'][K]['args']
      ): Promise<CoreSide['requests'][K]['result']> =>
        answered((await supervisor.core).link.request(name, ...args));
      // How corrallm ends, every way it may (B14 C2, C4), and how a window comes back (C10).
      const quit = new QuitCoordinator<BrowserWindow>({
        changed: () => {
          nativePresence.refresh();
          if (quit.approved) for (const native of notifications) native.close();
        },
        platform: process.platform,
        hidden,
        core: {
          presence: () => supervisor.presence,
          flushDrafts: (windows, reason) =>
            reason === undefined
              ? ask('flushDrafts', windows)
              : ask('flushDrafts', windows, reason),
          prepare: (reason, options) =>
            options === undefined
              ? ask('prepareShutdown', reason)
              : ask('prepareShutdown', reason, options),
          cancel: () => ask('cancelShutdown'),
          commit: () => ask('commitShutdown'),
          activate: (window, handle) => ask('activate', window, handle),
          exited: async () => (await supervisor.core).exited,
          stop: () => {
            supervisor.stop();
          },
        },
        windows: () => BrowserWindow.getAllWindows(),
        focused: () => BrowserWindow.getFocusedWindow(),
        open: openMainWindow,
        ask: async (window, options) => (await dialog.showMessageBox(window, options)).response,
        quit: () => {
          app.quit();
        },
        exit: (code) => {
          disposePresence();
          app.exit(code);
        },
        updates: () => updates,
        log: (...args) => {
          console.error(...args);
        },
      });
      const nativePresence = new PresencePresentation({
        platform: process.platform,
        hidden,
        backend: electronPresence(
          process.platform,
          app.isPackaged
            ? path.join(process.resourcesPath, 'presence')
            : path.join(app.getAppPath(), 'build/presence'),
        ),
        windowShown: () =>
          BrowserWindow.getAllWindows().some(
            (window) => window.isVisible() && !window.isMinimized(),
          ),
        quitting: () => quit,
        actions: {
          open: () => {
            void quit.reopen();
          },
          quit: () => {
            quit.request('user');
          },
          pauseAll: () => ask('pauseAll'),
        },
        log: (message) => {
          console.error(message);
        },
      });
      disposePresence = () => {
        nativePresence.close();
        for (const native of notifications) native.close();
      };
      nativePresence.update(undefined);
      try {
        await supervisor.start();
      } catch (error) {
        if (!(error instanceof ProfileLocked)) throw error;
        refuseLocked(error);
        return;
      }
      app.once('will-quit', () => {
        disposePresence();
        updates?.stop();
        supervisor.stop();
      });

      hardenSession(session.defaultSession, trustedOrigin);
      if (devServerUrl === undefined) {
        serveAppScheme({
          root: path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME),
          host: rendererHost,
          csp: PROD_CSP,
        });
      }
      registerIpcHandlers(trustedOrigin, ports);

      app.on('before-quit', (event) => {
        quit.beforeQuit(event);
      });
      // A window gaining focus has the core check the file of the canvas it shows for a change on
      // disk (B9 Design §5): one made in another program while corrallm was in the background.
      app.on('browser-window-focus', (_event, window) => {
        supervisor.windowFocused(window.webContents.id);
        supervisor.focus(BrowserWindow.getFocusedWindow() !== null);
        nativePresence.refresh();
      });
      app.on('browser-window-blur', () => {
        supervisor.focus(BrowserWindow.getFocusedWindow() !== null);
        nativePresence.refresh();
      });
      powerMonitor.on('resume', () => {
        supervisor.resumed();
      });
      // The system's shutdown, restart or power off, and on macOS its logout (B14 C4): corrallm
      // saves and closes within its budget, asking nothing, then quits itself. Electron passes the
      // event, which its typings leave out.
      powerMonitor.on('shutdown', (event?: Electron.Event) => {
        quit.shutdown(event);
      });
      // Opening corrallm again while it runs (the single instance's lock) shows its window: the
      // way back to one closed while the core kept working, on every platform.
      app.on('second-instance', () => {
        void quit.reopen();
      });
      app.on('browser-window-created', (_event, window) => {
        const refresh = () => {
          nativePresence.refresh();
        };
        window.on('show', refresh);
        window.on('hide', refresh);
        window.on('minimize', refresh);
        window.on('restore', refresh);
        window.on('closed', () => {
          supervisor.focus(BrowserWindow.getFocusedWindow() !== null);
          nativePresence.refresh();
        });
        // A window closing only finishes the drafts it composes: its canvas runs on in the core,
        // which a window only views (B11 Design §8); on Linux and Windows the last one asks first.
        window.on('close', (event) => {
          quit.windowClosing(window, event);
        });
        // Windows has no before-quit at logout (B14 C4, held for B29): its window hears it.
        if (process.platform === 'win32') {
          window.on('query-session-end', () => {
            quit.request('system');
          });
          window.on('session-end', () => {
            quit.request('system');
          });
        }
      });
      // A window destroyed without its close leaves none: on Linux and Windows, the last.
      allClosed = () => {
        nativePresence.refresh();
        quit.allClosed();
      };

      try {
        await openMainWindow();
      } catch (error) {
        // Destroying a window mid-load rejects loadURL as ERR_ABORTED or ERR_FAILED. Only
        // an approved quit makes those expected; other startup errors still fail on stderr.
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (!quit.approved) throw error;
        if (code !== 'ERR_ABORTED' && code !== 'ERR_FAILED') {
          // Preserve the error exit, but still let the approved core teardown finish first.
          quit.fail('Failed to start:', error);
        }
      }
      if (quit.approved) return;

      updates = startAppUpdates({
        // Restart to update is a quit of its own: it joins one going on, never its escape.
        requestQuit: () => {
          quit.request('update');
        },
        openRelease: async (url) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window) throw new Error('There is no app window to open the release page.');
          await ask('openLink', window.webContents.id, url);
        },
      });

      // macOS: the Dock icon clicked with no window shown shows one again (B14 C10).
      app.on('activate', (_event, hasVisibleWindows) => {
        if (!hasVisibleWindows) void quit.reopen();
      });
    })
    .catch((error: unknown) => {
      console.error('Failed to start:', error);
      disposePresence();
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    allClosed();
  });
}

/** A failed core request must stop a save/close, with its sentence intact. */
async function answered<T>(asked: Promise<Answer<T>>): Promise<T> {
  const answer = await asked;
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value;
}

main();
