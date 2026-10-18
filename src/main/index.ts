import path from 'node:path';

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import type { MessageBoxOptions } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import { APP_SCHEME, registerAppSchemePrivileges, serveAppScheme } from './app-protocol';
import { CanvasFiles } from './canvas';
import { Closing } from './closing';
import { PROD_CSP } from './csp';
import { ProjectFiles } from './files';
import { LinkOpener } from './host/links';
import { FileRevealer } from './host/reveal';
import { hostServices } from './host/services';
import { Windows } from './host/windows';
import { registerIpcHandlers, sendEvent } from './ipc';
import { CanvasMemory } from './memory';
import { runNativeSelfTest } from './native-selftest';
import { ProjectFolders } from './project';
import { RunJournal } from './run-journal';
import { RunShutdown } from './run-shutdown';
import { hardenSession, installNavigationGuards } from './security';
import { Settings } from './settings';
import { createConnectors, createOptions } from './sessions/connectors';
import { agentEnvironment, loginShellEnvironment } from './sessions/environment';
import { installedClis } from './sessions/installed';
import { SessionManager } from './sessions/manager';
import { Conversations } from './sessions/sdk/conversations';
import { originKey } from './url-policy';
import { UsageReadings } from './usage';
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
      // What main remembers of each canvas: its file, its project folder, its agents' conversations.
      const memory = new CanvasMemory(path.join(app.getPath('userData'), 'canvases.json'));
      // What the user chose for the app as a whole.
      const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
      const canvases = new CanvasFiles({ host: hostServices, memory });
      const projects = new ProjectFolders({ host: hostServices, memory });
      const runs = new RunJournal(path.join(app.getPath('userData'), 'runs'), {
        memory,
        projectOf: (canvas) => projects.of(canvas),
      });
      // Which canvas each window shows: a new window shows the one the profile had open last.
      const windows: Windows = new Windows(trustedOrigin, {
        restore: async () => {
          const canvas = await runs.last();
          await projects.restore(canvas);
          return canvas;
        },
        left: (canvas) => sessions.closeCanvas(canvas),
      });
      const shutdown = new RunShutdown((contents, requestId) => {
        sendEvent(contents, 'run:stopping', requestId);
      });
      // Every backend's usage, read from its agents' CLIs: every window hears each change.
      const usage = new UsageReadings({ file: path.join(app.getPath('userData'), 'usage.json') });
      await usage.load();
      usage.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          sendEvent(window.webContents, 'usage:changed', state);
        }
      });
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
          distribution: CORRALLM_DISTRIBUTION,
          consent: (adapter, key) => settings.consent(adapter, key),
          usage: (backend, windows) => {
            usage.take(backend, windows);
          },
        }),
        environment: agentsEnvironment,
        options: createOptions({ fake: fakeSessions }),
        // The conversations Claude Code kept, whichever connection ran them.
        conversations: new Conversations(),
        projectOf: (canvas) => projects.of(canvas),
        memory,
        emit: (canvas, agentId, connection, event) => {
          for (const contents of windows.showing(canvas)) {
            sendEvent(contents, 'session:event', agentId, connection, event);
          }
        },
        terminal: (canvas, agentId, event) => {
          for (const contents of windows.showing(canvas)) {
            sendEvent(contents, 'terminal:event', agentId, event);
          }
        },
      });
      const files = new ProjectFiles({ environment: agentsEnvironment });
      const links = new LinkOpener({
        file: path.join(app.getPath('userData'), 'links.json'),
        ask: async (contents, host, url) => {
          const options: MessageBoxOptions = {
            type: 'question',
            message: `Open ${host} in your browser?`,
            detail: url.length > 300 ? `${url.slice(0, 300)}…` : url,
            buttons: ['Open', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            checkboxLabel: 'Always for this site',
            noLink: true,
          };
          const window = BrowserWindow.fromWebContents(contents);
          const { response, checkboxChecked } = await (window
            ? dialog.showMessageBox(window, options)
            : dialog.showMessageBox(options));
          return { open: response === 0, always: response === 0 && checkboxChecked };
        },
        openExternal: (url) => shell.openExternal(url),
      });
      // Which CLIs the user has, for the templates' agents.
      const clis = { installed: async () => installedClis(await agentsEnvironment()) };
      // file:// links in a terminal: shown in the file manager, if in the project folder.
      const reveal = new FileRevealer({
        folderOf: (canvas) => projects.of(canvas),
        show: (file) => {
          shell.showItemInFolder(file);
        },
      });
      registerIpcHandlers(trustedOrigin, {
        windows,
        canvases,
        runs,
        shutdown,
        projects,
        files,
        links,
        reveal,
        sessions,
        clis,
        usage,
      });

      // Renderer acknowledgement comes before closing CLIs or flushing native session IDs.
      const persistWindows = async (closing: BrowserWindow[]) => {
        await Promise.all(
          closing.map((window) =>
            windows.has(window.webContents) ? shutdown.stop(window.webContents) : Promise.resolve(),
          ),
        );
        await runs.flush();
        await sessions.closeEverything();
        await Promise.all([memory.flush(), settings.flush(), links.flush(), usage.flush()]);
      };
      // Closing without saving (the user said to, after it failed): what can be closed, within a
      // few seconds.
      const abandon = async () => {
        await Promise.race([
          Promise.allSettled([sessions.closeEverything()]).then(() =>
            Promise.allSettled([memory.flush(), settings.flush(), links.flush(), usage.flush()]),
          ),
          new Promise((resolve) => setTimeout(resolve, ABANDON_MS)),
        ]);
      };
      const askAnyway =
        (verb: 'Quit' | 'Close', window?: BrowserWindow) =>
        async (why: string): Promise<boolean> => {
          console.error('Could not save before closing:', why);
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
        save: () => persistWindows(BrowserWindow.getAllWindows()),
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
        // A reload keeps the window's canvas but ends its sessions (run:get waits for them to
        // close before restoring); a crash or close ends them too.
        windows.watch(window.webContents);
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

main();
