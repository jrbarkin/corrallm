import { EventEmitter } from 'node:events';

import { AppUpdates } from './updates';
import type { UpdateEvents } from './updates';
import type { AppUpdateActions } from './host/updates';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const {
  app,
  powerMonitor,
  registerPrivileges,
  installGuards,
  getAllWindows,
  getFocusedWindow,
  showMessageBox,
  showErrorBox,
} = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    setActivationPolicy: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    enableSandbox: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    getPath: vi.fn(() => '/app/profile'),
    getName: vi.fn(() => 'corrallm'),
    getVersion: vi.fn(() => '1.2.3'),
    getLocale: vi.fn(() => 'en-US'),
    commandLine: { hasSwitch: vi.fn<(name: string) => boolean>(() => false) },
  },
  powerMonitor: { on: vi.fn() },
  getAllWindows: vi.fn<() => unknown[]>(() => []),
  getFocusedWindow: vi.fn<() => unknown>(() => null),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(
    () => new Promise(() => undefined),
  ),
  showErrorBox: vi.fn(),
  registerPrivileges: vi.fn(),
  installGuards: vi.fn(),
}));

// The core and windows are faked: boot and closing never start sessions or write user data.
vi.mock('electron', () => ({
  app,
  powerMonitor,
  BrowserWindow: { getAllWindows, getFocusedWindow },
  dialog: { showMessageBox, showErrorBox },
  session: { defaultSession: {} },
  shell: {},
  ipcMain: { handle: vi.fn() },
}));
vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('./app-protocol', () => ({
  APP_SCHEME: 'app',
  registerAppSchemePrivileges: registerPrivileges,
  serveAppScheme: vi.fn(),
}));
vi.mock('./security', () => ({
  hardenSession: vi.fn(),
  installNavigationGuards: installGuards,
  isTrustedSender: vi.fn(),
}));
vi.mock('./native-selftest', () => ({ runNativeSelfTest: vi.fn() }));
const { startAppUpdates } = vi.hoisted(() => ({
  startAppUpdates: vi.fn<
    (_actions: AppUpdateActions) => Pick<AppUpdates, 'finishQuit' | 'cancelRestart' | 'stop'>
  >(() => ({
    finishQuit: () => false,
    cancelRestart: () => undefined,
    stop: () => undefined,
  })),
}));
vi.mock('./host/updates', () => ({ startAppUpdates }));
const { request, createWindow, makeHost, forkCore, cores, reconnect, now } = vi.hoisted(() => {
  const request = vi.fn<
    (name: string, ...args: unknown[]) => Promise<{ ok: true; value: unknown }>
  >(() => Promise.resolve({ ok: true, value: null }));
  /** Each core process forked: how to end it, as a crash would, and what it tells main. */
  const cores: {
    exit: (code: number) => void;
    emit: (name: string, ...args: unknown[]) => void;
  }[] = [];
  /** What the core says it does now (B14 C5): idle, unless a test says otherwise. */
  const now: { presence: unknown } = { presence: undefined };
  return {
    request,
    createWindow: vi.fn<() => Promise<unknown>>(() => Promise.resolve()),
    makeHost: vi.fn<() => unknown>(() => ({})),
    cores,
    now,
    forkCore: vi.fn(() => {
      const exited = Promise.withResolvers<number>();
      const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
      cores.push({
        exit: exited.resolve,
        emit: (name, ...args) => {
          for (const listener of listeners.get(name) ?? []) listener(...args);
        },
      });
      return {
        link: {
          request,
          on: (name: string, listener: (...args: unknown[]) => void) => {
            listeners.set(name, [...(listeners.get(name) ?? []), listener]);
            return () => undefined;
          },
        },
        get presence() {
          return now.presence;
        },
        exited: exited.promise,
        connect: vi.fn(),
        windowGone: vi.fn(),
        windowFocused: vi.fn(),
        resumed: vi.fn(),
        kill: vi.fn(),
      };
    }),
    reconnect: vi.fn(),
  };
});
vi.mock('./host/core-process', () => ({ forkCore }));
vi.mock('./host/ports', () => ({
  CorePorts: class {
    reconnect = reconnect;
    connect = vi.fn();
  },
}));
vi.mock('./host/services', () => ({ hostServices: makeHost }));
vi.mock('./window', () => ({ createMainWindow: createWindow }));

/**
 * What the core answers main unless a test says otherwise: every window's drafts flushed, the
 * shutdown barrier prepared, no work going on, else null.
 */
function answered(name: string): Promise<{ ok: true; value: unknown }> {
  const value =
    name === 'flushDrafts' ? { unanswered: [] } : name === 'prepareShutdown' ? { ok: true } : null;
  return Promise.resolve({ ok: true, value });
}

/** Nothing at work: what an idle core counts (B14 C5). */
const IDLE = { revision: 1, working: 0, runs: 0, jobs: 0, needs: 0, busy: false, awake: false };
/** Two agents in a turn, on a canvas whose run is going. */
const BUSY = { revision: 2, working: 2, runs: 1, jobs: 0, needs: 0, busy: true, awake: true };

/** A corrallm window, as main sees it: its events, and what main may do to it. */
function fakeWindow(id: number) {
  const contents = { id, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
  return Object.assign(new EventEmitter(), {
    webContents: contents,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    minimize: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  });
}

/** Runs `body` as if on `platform`. */
async function onPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await body();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}

/** The handler main gave Electron for `event` (an app event unless `emitter` says otherwise). */
function handler(event: string, emitter: { on: Mock } = app): (...args: unknown[]) => void {
  const found = emitter.on.mock.calls.find(([name]) => name === event)?.[1] as
    ((...args: unknown[]) => void) | undefined;
  if (!found) throw new Error(`No handler for ${event}`);
  return found;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getAllWindows.mockReturnValue([]);
  getFocusedWindow.mockReturnValue(null);
  now.presence = IDLE;
  cores.splice(0);
  request.mockReset();
  request.mockImplementation((name) => answered(name));
  app.requestSingleInstanceLock.mockReturnValue(true);
  app.quit.mockReset();
  app.isPackaged = false;
  app.commandLine.hasSwitch.mockReturnValue(false);
  app.whenReady.mockImplementation(() => new Promise<void>(() => undefined));
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('CORRALLM_DISTRIBUTION', 'local');
  vi.stubEnv('CORRALLM_NATIVE_SELFTEST', undefined);
  vi.stubEnv('CORRALLM_HIDE_WINDOW', undefined);
});

describe('an update restart', () => {
  it('opens its release page through the core operation for an existing window', async () => {
    app.whenReady.mockResolvedValueOnce();
    getAllWindows.mockReturnValue([{ webContents: { id: 7 } }]);
    await import('./index');
    await vi.waitFor(() => {
      expect(startAppUpdates).toHaveBeenCalledOnce();
    });
    const actions = startAppUpdates.mock.calls[0]?.[0];
    await actions?.openRelease('https://github.com/jrbarkin/corrallm/releases/tag/v1.3.0');
    expect(request).toHaveBeenCalledWith(
      'openLink',
      7,
      'https://github.com/jrbarkin/corrallm/releases/tag/v1.3.0',
    );
  });

  it.each([false, true])(
    'saves and flushes before installation (quit already saving: %s)',
    async (alreadySaving) => {
      app.whenReady.mockResolvedValueOnce();
      const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
      getAllWindows.mockReturnValue([{ webContents: contents }]);
      const flushed = Promise.withResolvers<{ ok: true; value: { ok: true } }>();
      const closed = Promise.withResolvers<{ ok: true; value: null }>();
      request.mockImplementation((name) =>
        name === 'prepareShutdown'
          ? flushed.promise
          : name === 'commitShutdown'
            ? closed.promise
            : answered(name),
      );
      let events: UpdateEvents | undefined;
      const install = vi.fn();
      let updates: AppUpdates | undefined;
      startAppUpdates.mockImplementationOnce((actions) => {
        updates = new AppUpdates({
          ...actions,
          packaged: true,
          development: false,
          selfTest: false,
          disabled: false,
          unsigned: false,
          platform: 'darwin',
          arch: 'arm64',
          version: '1.2.3',
          signedMac: () => Promise.resolve(true),
          fetch: vi.fn(),
          prompt: () => Promise.resolve(0),
          log: vi.fn(),
          updater: {
            listen: (listeners) => {
              events = listeners;
              return () => undefined;
            },
            setFeedURL: vi.fn(),
            checkForUpdates: vi.fn(),
            quitAndInstall: install,
          },
        });
        void updates.start();
        return updates;
      });
      await import('./index');
      await vi.waitFor(() => {
        expect(events).toBeDefined();
      });
      const beforeQuit = app.on.mock.calls.find(
        ([name]) => name === 'before-quit',
      )?.[1] as (event: { preventDefault(): void }) => void;
      app.quit.mockImplementation(() => {
        beforeQuit({ preventDefault: vi.fn() });
      });
      if (alreadySaving) app.quit();
      events?.downloaded('1.3.0');
      // Each window's drafts first; then, its canvas's run being the core's (B11 Design §8),
      // Restart to update prepares the same barrier as a quit, saying why: with nothing at work,
      // only if the core still finds nothing at work (B14 C2).
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith('prepareShutdown', 'update', { ifIdle: true });
      });
      // It joins a quit already saving, never as a second request that forces Closing to abandon.
      expect(app.quit).toHaveBeenCalledTimes(alreadySaving ? 1 : 0);
      expect(request.mock.calls.filter(([name]) => name === 'prepareShutdown')).toHaveLength(1);
      expect(request).toHaveBeenCalledWith('flushDrafts', [7]);
      expect(contents.send).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      flushed.resolve({ ok: true, value: { ok: true } });
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith('commitShutdown');
      });
      expect(install).not.toHaveBeenCalled();
      closed.resolve({ ok: true, value: null });
      await vi.waitFor(() => {
        expect(install).toHaveBeenCalledOnce();
      });
      expect(request.mock.calls.map(([name]) => name)).toEqual([
        'init',
        'flushDrafts',
        'prepareShutdown',
        'commitShutdown',
      ]);
      updates?.stop();
    },
  );

  it.each(['drafts', 'core'])(
    'never installs when %s saving fails and Keep corrallm open is chosen',
    async (where) => {
      app.whenReady.mockResolvedValueOnce();
      showMessageBox.mockResolvedValueOnce({ response: 0 });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // The failed-save question is a sheet on this window (B14 C2).
      const window = fakeWindow(7);
      const contents = window.webContents;
      getAllWindows.mockReturnValue([window]);
      request.mockImplementation((name) =>
        name === 'prepareShutdown'
          ? Promise.resolve({ ok: true, value: { failed: true, sentence: 'Disk full' } })
          : name === 'flushDrafts' && where === 'drafts'
            ? Promise.resolve({ ok: true, value: { unanswered: [7] } })
            : answered(name),
      );
      let restart: (() => void) | undefined;
      const finishQuit = vi.fn(() => true);
      const cancelRestart = vi.fn();
      startAppUpdates.mockImplementationOnce((actions) => {
        restart = actions.requestQuit;
        return { finishQuit, cancelRestart, stop: () => undefined };
      });
      await import('./index');
      await vi.waitFor(() => {
        expect(restart).toBeDefined();
      });
      const beforeQuit = app.on.mock.calls.find(
        ([name]) => name === 'before-quit',
      )?.[1] as (event: { preventDefault(): void }) => void;
      app.quit.mockImplementation(() => {
        beforeQuit({ preventDefault: vi.fn() });
      });
      restart?.();
      await vi.waitFor(() => {
        expect(cancelRestart).toHaveBeenCalledOnce();
      });
      expect(contents.send).not.toHaveBeenCalled();
      expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(window, expect.anything());
      expect(finishQuit).not.toHaveBeenCalled();
      // Keep corrallm open lifts the core's barrier: the endpoint and every turn go on.
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith('cancelShutdown');
      });
      expect(request.mock.calls.map(([name]) => name)).toEqual(
        where === 'drafts'
          ? ['init', 'flushDrafts', 'cancelShutdown']
          : ['init', 'flushDrafts', 'prepareShutdown', 'cancelShutdown'],
      );
      expect(request).not.toHaveBeenCalledWith('commitShutdown');
    },
  );
});

describe('the drafts each window composes', () => {
  it.each(['Quit', 'Close'] as const)(
    '%s: a window that doesn’t finish them is said in the failed-save dialog, and Keep corrallm open keeps everything',
    async (verb) => {
      app.whenReady.mockResolvedValueOnce();
      showMessageBox.mockResolvedValueOnce({ response: 0 });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const window = fakeWindow(7);
      const contents = window.webContents;
      getAllWindows.mockReturnValue([window]);
      request.mockImplementation((name) =>
        name === 'flushDrafts'
          ? Promise.resolve({ ok: true, value: { unanswered: [7] } })
          : answered(name),
      );
      await import('./index');
      await vi.waitFor(() => {
        expect(createWindow).toHaveBeenCalledOnce();
      });
      if (verb === 'Quit') {
        const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
          event: unknown,
        ) => void;
        beforeQuit({ preventDefault: vi.fn() });
      } else {
        const created = app.on.mock.calls.find(
          ([name]) => name === 'browser-window-created',
        )?.[1] as (event: unknown, window: unknown) => void;
        created({}, window);
        window.emit('close', { preventDefault: vi.fn() });
      }
      await vi.waitFor(() => {
        expect(showMessageBox).toHaveBeenCalledOnce();
      });
      // A sheet on the window either way (B14 C2), so the system can withdraw it.
      expect(showMessageBox.mock.calls[0]?.[0]).toBe(window);
      expect(showMessageBox.mock.calls[0]).toContainEqual(
        expect.objectContaining({
          message: 'The run could not be saved',
          detail: expect.stringContaining(
            'A window did not finish saving what was being typed in it before closing',
          ) as string,
        }),
      );
      // Nothing of the window's run was asked, nor anything of the core but the drafts.
      expect(contents.send).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalledWith('prepareShutdown', expect.anything());
      expect(request).not.toHaveBeenCalledWith('commitShutdown');
      expect(app.quit).not.toHaveBeenCalled();
      expect(window.close).not.toHaveBeenCalled();
    },
  );
});

describe('a window, again', () => {
  async function started() {
    app.whenReady.mockResolvedValueOnce();
    await import('./index');
    await vi.waitFor(() => {
      expect(createWindow).toHaveBeenCalledOnce();
    });
  }
  const on = (event: string) =>
    app.on.mock.calls.find(([name]) => name === event)?.[1] as () => void;

  it('is shown when corrallm is opened again: the window there, else a new one', async () => {
    await started();
    const shown = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    getAllWindows.mockReturnValue([shown]);
    on('second-instance')();
    expect(shown.restore).toHaveBeenCalledOnce();
    expect(shown.show).toHaveBeenCalledOnce();
    expect(shown.focus).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledOnce();
    getAllWindows.mockReturnValue([]);
    on('second-instance')();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it.each(['linux', 'win32'] as const)(
    'on %s, every window gone without its close is the last: it quits when nothing is at work',
    async (platform) => {
      await onPlatform(platform, async () => {
        await started();
        handler('window-all-closed')();
        await vi.waitFor(() => {
          expect(app.quit).toHaveBeenCalledOnce();
        });
        expect(request.mock.calls.filter(([name]) => name === 'prepareShutdown')).toEqual([
          ['prepareShutdown', 'quit', { ifIdle: true }],
        ]);
        expect(showMessageBox).not.toHaveBeenCalled();
      });
    },
  );

  it('on macOS, every window gone quits nothing and asks nothing', async () => {
    await onPlatform('darwin', async () => {
      now.presence = BUSY;
      await started();
      handler('window-all-closed')();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(app.quit).not.toHaveBeenCalled();
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([name]) => name)).toEqual(['init']);
    });
  });

  it('is shown when the Dock icon is clicked with no window shown, and only then', async () => {
    await started();
    await vi.waitFor(() => {
      expect(startAppUpdates).toHaveBeenCalledOnce();
    });
    const window = fakeWindow(7);
    getAllWindows.mockReturnValue([window]);
    handler('activate')({}, true);
    expect(window.focus).not.toHaveBeenCalled();
    window.isMinimized.mockReturnValue(true);
    handler('activate')({}, false);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    getAllWindows.mockReturnValue([]);
    handler('activate')({}, false);
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it('on Windows, takes a window’s session end through the system path (held for B29)', async () => {
    await onPlatform('win32', async () => {
      await started();
      const window = fakeWindow(7);
      getAllWindows.mockReturnValue([window]);
      handler('browser-window-created')({}, window);
      window.emit('session-end');
      await vi.waitFor(() => {
        expect(app.quit).toHaveBeenCalledOnce();
      });
      expect(request).toHaveBeenCalledWith('prepareShutdown', 'system');
      expect(showMessageBox).not.toHaveBeenCalled();
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('waiting for the approved core shutdown', () => {
  it.each([
    { update: false, anyway: false },
    { update: true, anyway: false },
    { update: false, anyway: true },
    { update: true, anyway: true },
  ])(
    'awaits a nine-second core close (update: $update, Quit anyway: $anyway)',
    async ({ update, anyway }) => {
      app.whenReady.mockResolvedValueOnce();
      if (anyway) {
        // Quit anyway, chosen on the failed-save question: a sheet on the window (B14 C2).
        getAllWindows.mockReturnValue([fakeWindow(7)]);
        showMessageBox.mockResolvedValueOnce({ response: 1 });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
      }
      let coreClosed = false;
      request.mockImplementation((name) => {
        if (name === 'commitShutdown')
          return new Promise((resolve) => {
            setTimeout(() => {
              coreClosed = true;
              resolve({ ok: true, value: null });
            }, 9000);
          });
        if (name === 'prepareShutdown' && anyway)
          return Promise.resolve({ ok: true, value: { failed: true, sentence: 'Disk full' } });
        return answered(name);
      });
      const install = vi.fn();
      const finishQuit = vi.fn(() => {
        if (update) install();
        return update;
      });
      let restart: (() => void) | undefined;
      startAppUpdates.mockImplementationOnce((actions) => {
        restart = actions.requestQuit;
        return { finishQuit, cancelRestart: vi.fn(), stop: vi.fn() };
      });
      await import('./index');
      await vi.waitFor(() => {
        expect(startAppUpdates).toHaveBeenCalledOnce();
      });
      const beforeQuit = app.on.mock.calls.find(
        ([name]) => name === 'before-quit',
      )?.[1] as (event: { preventDefault(): void }) => void;
      app.quit.mockImplementation(() => {
        beforeQuit({ preventDefault: vi.fn() });
      });
      vi.useFakeTimers();
      if (update) restart?.();
      else beforeQuit({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith('commitShutdown');
      // An update first requests the ordinary quit; only the final quit/install is under test.
      app.quit.mockClear();
      await vi.advanceTimersByTimeAsync(8999);
      expect(coreClosed).toBe(false);
      expect(app.quit).not.toHaveBeenCalled();
      expect(finishQuit).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(coreClosed).toBe(true);
      expect(finishQuit).toHaveBeenCalledOnce();
      expect(app.quit).toHaveBeenCalledTimes(update ? 0 : 1);
      expect(install).toHaveBeenCalledTimes(update ? 1 : 0);
      expect(request.mock.calls.filter(([name]) => name === 'commitShutdown')).toHaveLength(1);
    },
  );

  it('keeps the five-second escape for an explicit second quit while saving hangs', async () => {
    app.whenReady.mockResolvedValueOnce();
    request.mockImplementation((name) => {
      if (name === 'prepareShutdown' || name === 'commitShutdown')
        return new Promise(() => undefined);
      return answered(name);
    });
    const finishQuit = vi.fn(() => false);
    startAppUpdates.mockReturnValueOnce({ finishQuit, cancelRestart: vi.fn(), stop: vi.fn() });
    await import('./index');
    await vi.waitFor(() => {
      expect(startAppUpdates).toHaveBeenCalledOnce();
    });
    const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (event: {
      preventDefault(): void;
    }) => void;
    vi.useFakeTimers();
    beforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith('prepareShutdown', 'quit', { ifIdle: true });
    beforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(4999);
    expect(app.quit).not.toHaveBeenCalled();
    expect(finishQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(finishQuit).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([name]) => name === 'commitShutdown')).toHaveLength(1);
  });

  it.each([false, true])(
    'gives a second quit the five-second escape while an approved core close hangs (Quit anyway: %s)',
    async (anyway) => {
      app.whenReady.mockResolvedValueOnce();
      if (anyway) {
        // Quit anyway, chosen on the failed-save question: a sheet on the window (B14 C2).
        getAllWindows.mockReturnValue([fakeWindow(7)]);
        showMessageBox.mockResolvedValueOnce({ response: 1 });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
      }
      request.mockImplementation((name) => {
        // The save succeeds (or fails and the user quits anyway); the core's close never settles.
        if (name === 'commitShutdown') return new Promise(() => undefined);
        if (name === 'prepareShutdown' && anyway)
          return Promise.resolve({ ok: true, value: { failed: true, sentence: 'Disk full' } });
        return answered(name);
      });
      const finishQuit = vi.fn(() => false);
      startAppUpdates.mockReturnValueOnce({ finishQuit, cancelRestart: vi.fn(), stop: vi.fn() });
      await import('./index');
      await vi.waitFor(() => {
        expect(startAppUpdates).toHaveBeenCalledOnce();
      });
      const beforeQuit = app.on.mock.calls.find(
        ([name]) => name === 'before-quit',
      )?.[1] as (event: { preventDefault(): void }) => void;
      vi.useFakeTimers();
      beforeQuit({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith('commitShutdown');
      // With no second quit, the approved quit keeps waiting for the core.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(app.quit).not.toHaveBeenCalled();
      const again = vi.fn();
      beforeQuit({ preventDefault: again });
      expect(again).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4999);
      expect(app.quit).not.toHaveBeenCalled();
      expect(finishQuit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(app.quit).toHaveBeenCalledOnce();
      expect(finishQuit).toHaveBeenCalledOnce();
      expect(app.exit).not.toHaveBeenCalled();
      // The final quit goes through, and a third quit meanwhile started nothing more.
      const final = vi.fn();
      beforeQuit({ preventDefault: final });
      expect(final).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([name]) => name === 'commitShutdown')).toHaveLength(1);
    },
  );
});

describe('quit races', () => {
  function beforeQuit() {
    const callback = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as
      ((event: { preventDefault(): void }) => void) | undefined;
    if (!callback) throw new Error('No quit handler');
    return callback;
  }

  it('quits cleanly when app.quit arrives before the window has loaded its editor', async () => {
    app.whenReady.mockResolvedValueOnce();
    vi.stubEnv('CORRALLM_HIDE_WINDOW', '1');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const window = new EventEmitter();
    const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
    Object.assign(window, { webContents: contents, close: vi.fn() });
    getAllWindows.mockReturnValue([window]);
    const loading = Promise.withResolvers<undefined>();
    const closed = Promise.withResolvers<{ ok: true; value: null }>();
    const drafts = Promise.withResolvers<{ ok: true; value: { unanswered: number[] } }>();
    createWindow.mockReturnValueOnce(loading.promise);
    request.mockImplementation((name) =>
      name === 'commitShutdown'
        ? closed.promise
        : name === 'flushDrafts'
          ? drafts.promise
          : answered(name),
    );
    await import('./index');
    await vi.waitFor(() => {
      expect(createWindow).toHaveBeenCalledOnce();
    });
    vi.useFakeTimers();
    // Playwright ElectronApplication.close evaluates app.quit(), without waiting for React. The
    // window's drafts come first (its preload answers at once with none); its run is the core's.
    beforeQuit()({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledWith('flushDrafts', [7]);
    expect(request).not.toHaveBeenCalledWith(
      'prepareShutdown',
      expect.anything(),
      expect.anything(),
    );
    drafts.resolve({ ok: true, value: { unanswered: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith('prepareShutdown', 'quit', { ifIdle: true });
    expect(contents.send).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    closed.resolve({ ok: true, value: null });
    loading.resolve(undefined);
    await vi.advanceTimersByTimeAsync(3000);
    expect(app.exit).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('commitShutdown');
    expect(app.quit).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('blocks a repeated before-quit until the approved core close has completed, within its escape', async () => {
    app.whenReady.mockResolvedValueOnce();
    const window = Object.assign(new EventEmitter(), { webContents: { id: 7 }, close: vi.fn() });
    getAllWindows.mockReturnValue([window]);
    const closed = Promise.withResolvers<{ ok: true; value: null }>();
    request.mockImplementation((name) =>
      name === 'commitShutdown' ? closed.promise : answered(name),
    );
    await import('./index');
    await vi.waitFor(() => {
      expect(startAppUpdates).toHaveBeenCalledOnce();
    });
    const created = app.on.mock.calls.find(([name]) => name === 'browser-window-created')?.[1] as (
      event: unknown,
      window: unknown,
    ) => void;
    created({}, window);
    vi.useFakeTimers();
    const quit = beforeQuit();
    quit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith('commitShutdown');
    const preventDefault = vi.fn();
    quit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const windowClose = vi.fn();
    window.emit('close', { preventDefault: windowClose });
    expect(windowClose).toHaveBeenCalledOnce();
    // The repeated quit is the escape: it never skips the wait, only bounds it to five seconds.
    await vi.advanceTimersByTimeAsync(4999);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
    closed.resolve({ ok: true, value: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledOnce();
    const final = vi.fn();
    quit({ preventDefault: final });
    expect(final).not.toHaveBeenCalled();
    const finalWindowClose = vi.fn();
    window.emit('close', { preventDefault: finalWindowClose });
    expect(finalWindowClose).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([name]) => name === 'commitShutdown')).toHaveLength(1);
  });

  it.each(['resolves', 'rejects'])(
    'does not let a window save that %s override an approved app quit',
    async (outcome) => {
      vi.stubEnv('CORRALLM_HIDE_WINDOW', '1');
      app.whenReady.mockResolvedValueOnce();
      const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
      const window = Object.assign(new EventEmitter(), { webContents: contents, close: vi.fn() });
      getAllWindows.mockReturnValue([window]);
      const windowSave = Promise.withResolvers<{ ok: true; value: { unanswered: number[] } }>();
      const closed = Promise.withResolvers<{ ok: true; value: null }>();
      let flushes = 0;
      request.mockImplementation((name) => {
        if (name === 'flushDrafts' && ++flushes === 1) return windowSave.promise;
        if (name === 'commitShutdown') return closed.promise;
        return answered(name);
      });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await import('./index');
      await vi.waitFor(() => {
        expect(startAppUpdates).toHaveBeenCalledOnce();
      });
      const created = app.on.mock.calls.find(
        ([name]) => name === 'browser-window-created',
      )?.[1] as (event: unknown, window: unknown) => void;
      created({}, window);
      vi.useFakeTimers();
      window.emit('close', { preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(flushes).toBe(1);
      beforeQuit()({ preventDefault: vi.fn() }); // Playwright's app.quit(), while a window close waits.
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith('commitShutdown');
      if (outcome === 'rejects') windowSave.reject(new Error('The core is closing.'));
      else windowSave.resolve({ ok: true, value: { unanswered: [] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(window.close).not.toHaveBeenCalled();
      expect(app.exit).not.toHaveBeenCalled();
      closed.resolve({ ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(app.quit).toHaveBeenCalledOnce();
      expect(app.exit).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(showMessageBox).not.toHaveBeenCalled();
    },
  );

  it('still reports a real initial window load failure before quit is approved', async () => {
    app.whenReady.mockResolvedValueOnce();
    const failure = new Error('The initial window could not load.');
    createWindow.mockRejectedValueOnce(failure);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('./index');
    await vi.waitFor(() => {
      expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
    });
    expect(stderr).toHaveBeenCalledWith('Failed to start:', failure);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it.each(['ERR_ABORTED', 'ERR_FAILED', 'ERR_FILE_NOT_FOUND'])(
    'handles an initial window’s %s after an approved app quit without hiding real failures',
    async (code) => {
      app.whenReady.mockResolvedValueOnce();
      const opening = Promise.withResolvers<undefined>();
      createWindow.mockReturnValueOnce(opening.promise);
      const closed = Promise.withResolvers<{ ok: true; value: null }>();
      request.mockImplementation((name) =>
        name === 'commitShutdown' ? closed.promise : answered(name),
      );
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await import('./index');
      await vi.waitFor(() => {
        expect(createWindow).toHaveBeenCalledOnce();
      });
      vi.useFakeTimers();
      beforeQuit()({ preventDefault: vi.fn() }); // firstWindow() does not wait for loadURL to finish.
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith('commitShutdown');
      const failure = Object.assign(new Error(`${code} loading app://main_window/index.html`), {
        code,
      });
      if (code === 'ERR_FILE_NOT_FOUND') {
        opening.reject(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();
      }
      closed.resolve({ ok: true, value: null });
      await vi.advanceTimersByTimeAsync(0);
      if (code !== 'ERR_FILE_NOT_FOUND') {
        expect(app.quit).toHaveBeenCalledOnce();
        opening.reject(failure);
        await vi.advanceTimersByTimeAsync(0);
      }
      if (code === 'ERR_FILE_NOT_FOUND') {
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(stderr).toHaveBeenCalledWith('Failed to start:', failure);
      } else {
        expect(app.exit).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
      }
      expect(startAppUpdates).not.toHaveBeenCalled();
    },
  );
});

describe('packaged launch switches', () => {
  it.each([
    'remote-debugging-port',
    'remote-debugging-pipe',
    'renderer-cmd-prefix',
    'gpu-launcher',
    'utility-cmd-prefix',
    'browser-subprocess-path',
  ])('refuses --%s before initialization, even for a native self-test', async (name) => {
    app.isPackaged = true;
    app.commandLine.hasSwitch.mockImplementation((candidate) => candidate === name);
    vi.stubEnv('CORRALLM_NATIVE_SELFTEST', '1');
    await import('./index');

    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(registerPrivileges).not.toHaveBeenCalled();
  });
});

describe('single-instance startup', () => {
  it('quits a second instance before reading user data or creating a window', async () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    await import('./index');

    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(registerPrivileges).not.toHaveBeenCalled();
    expect(installGuards).not.toHaveBeenCalled();
  });

  it('starts the instance holding the lock', async () => {
    await import('./index');

    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.whenReady).toHaveBeenCalledOnce();
    expect(installGuards).toHaveBeenCalledWith('app://main_window');
  });
});

describe('starting the app’s core', () => {
  it.each([false, true])(
    'passes the profile, app, distribution and locale, admitting fake sessions only unpackaged (packaged: %s)',
    async (packaged) => {
      app.isPackaged = packaged;
      app.whenReady.mockResolvedValueOnce();
      vi.stubEnv('CORRALLM_FAKE_SESSIONS', '1');
      await import('./index');
      await vi.waitFor(() => {
        expect(createWindow).toHaveBeenCalledOnce();
      });
      expect(request).toHaveBeenCalledExactlyOnceWith('init', {
        app: { name: 'corrallm', version: '1.2.3' },
        profile: '/app/profile',
        distribution: 'local',
        locale: 'en-US',
        fakeSessions: !packaged,
      });
    },
  );
});

it('tells the core when a window gains focus, so the canvas it shows has its file checked', async () => {
  app.whenReady.mockResolvedValueOnce();
  await import('./index');
  await vi.waitFor(() => {
    expect(createWindow).toHaveBeenCalledOnce();
  });
  const focus = app.on.mock.calls.find(([name]) => name === 'browser-window-focus')?.[1] as (
    event: unknown,
    window: unknown,
  ) => void;
  focus({}, { webContents: { id: 7 } });
  const core = forkCore.mock.results[0]?.value as { windowFocused: (window: number) => void };
  await vi.waitFor(() => {
    expect(core.windowFocused).toHaveBeenCalledExactlyOnceWith(7);
  });
});

it('tells the current core when powerMonitor reports resume', async () => {
  app.whenReady.mockResolvedValueOnce();
  await import('./index');
  await vi.waitFor(() => {
    expect(createWindow).toHaveBeenCalledOnce();
  });
  const resume = powerMonitor.on.mock.calls.find(([name]) => name === 'resume')?.[1] as
    (() => void) | undefined;
  expect(resume).toBeTypeOf('function');
  resume?.();
  const core = forkCore.mock.results[0]?.value as { resumed: () => void };
  await vi.waitFor(() => {
    expect(core.resumed).toHaveBeenCalledOnce();
  });
});

describe('a hidden app that cannot save before closing', () => {
  it.each(['Quit', 'Close'])(
    '%s reports the failure and exits nonzero without a native dialog',
    async (verb) => {
      vi.stubEnv('CORRALLM_HIDE_WINDOW', '1');
      app.whenReady.mockResolvedValueOnce();
      const contents = {
        id: 7,
        isDestroyed: () => false,
        isCrashed: () => false,
        send: vi.fn(),
      };
      const window = Object.assign(new EventEmitter(), { webContents: contents, close: vi.fn() });
      getAllWindows.mockReturnValue([window]);
      request.mockImplementation((name) =>
        name === 'flushDrafts'
          ? Promise.resolve({ ok: true, value: { unanswered: [7] } })
          : answered(name),
      );
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await import('./index');
      await vi.waitFor(() => {
        expect(createWindow).toHaveBeenCalledOnce();
      });
      vi.useFakeTimers();
      const preventDefault = vi.fn();
      if (verb === 'Quit') {
        const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
          event: unknown,
        ) => void;
        beforeQuit({ preventDefault });
      } else {
        const created = app.on.mock.calls.find(
          ([name]) => name === 'browser-window-created',
        )?.[1] as (event: unknown, window: unknown) => void;
        created({}, window);
        window.emit('close', { preventDefault });
      }
      await vi.advanceTimersByTimeAsync(3000);

      expect(contents.send).not.toHaveBeenCalled();
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        'Could not save before closing:',
        'A window did not finish saving what was being typed in it before closing',
      );
      expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(preventDefault).toHaveBeenCalledOnce();
    },
  );
});

it('keeps the core up until each window has finished its drafts, then prepares and commits its barrier', async () => {
  app.whenReady.mockResolvedValueOnce();
  const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
  getAllWindows.mockReturnValue([{ webContents: contents }]);
  const drafts = Promise.withResolvers<{ ok: true; value: { unanswered: number[] } }>();
  request.mockImplementation((name) => (name === 'flushDrafts' ? drafts.promise : answered(name)));
  await import('./index');
  await vi.waitFor(() => {
    expect(createWindow).toHaveBeenCalledOnce();
  });
  const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
    event: unknown,
  ) => void;
  beforeQuit({ preventDefault: vi.fn() });
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith('flushDrafts', [7]);
  });
  expect(request.mock.calls.map(([name]) => name)).toEqual(['init', 'flushDrafts']);
  expect(app.quit).not.toHaveBeenCalled();
  drafts.resolve({ ok: true, value: { unanswered: [] } });
  await vi.waitFor(() => {
    expect(app.quit).toHaveBeenCalledOnce();
  });
  expect(request.mock.calls.map(([name]) => name)).toEqual([
    'init',
    'flushDrafts',
    'prepareShutdown',
    'commitShutdown',
  ]);
  // Nothing is asked of the window but its drafts: its canvas's run is the core's (B11 §8).
  expect(contents.send).not.toHaveBeenCalled();
});

describe('the profile held by corrallm serve', () => {
  const locked = {
    ok: true,
    value: { profileLocked: { holder: { owner: 'serve', pid: 42, started: 1 } } },
  } as const;
  const detail =
    'corrallm serve (process 42) is using this profile. Stop it (Ctrl-C where it runs), then open corrallm again.';

  it.each([false, true])(
    'refuses to start when the core says serve holds the profile, saying so (hidden: %s)',
    async (hidden) => {
      if (hidden) vi.stubEnv('CORRALLM_HIDE_WINDOW', '1');
      app.whenReady.mockResolvedValueOnce();
      request.mockResolvedValueOnce(locked);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await import('./index');
      await vi.waitFor(() => {
        expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
      });

      expect(stderr).toHaveBeenCalledWith(`corrallm: ${detail}`);
      // The hidden e2e app shows nothing on screen, a dialog included.
      if (hidden) expect(showErrorBox).not.toHaveBeenCalled();
      else
        expect(showErrorBox).toHaveBeenCalledExactlyOnceWith(
          'corrallm can’t open its profile',
          detail,
        );
      expect(createWindow).not.toHaveBeenCalled();
    },
  );

  it('says to try again in a moment while corrallm token writes the profile’s tokens', async () => {
    app.whenReady.mockResolvedValueOnce();
    request.mockResolvedValueOnce({
      ok: true,
      value: { profileLocked: { holder: { owner: 'token', pid: 43, started: 1 } } },
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('./index');
    await vi.waitFor(() => {
      expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
    });
    expect(stderr).toHaveBeenCalledWith(
      'corrallm: corrallm token (process 43) is using this profile. Try again in a moment.',
    );
  });
});

describe('a core that crashes', () => {
  async function started() {
    app.whenReady.mockResolvedValueOnce();
    await import('./index');
    await vi.waitFor(() => {
      expect(createWindow).toHaveBeenCalledOnce();
    });
  }

  it('is restarted, asked up as the first was, and every window reconnects to it', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await started();

    cores[0]?.exit(9);
    await vi.waitFor(() => {
      expect(reconnect).toHaveBeenCalledOnce();
    });
    expect(forkCore).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([name]) => name)).toEqual(['init', 'init']);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(stderr).toHaveBeenCalledWith(
      'corrallm: the core process stopped (code 9); starting it again.',
    );
    expect(app.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'is given up on once it keeps stopping, saying so, and the app exits (hidden: %s)',
    async (hidden) => {
      if (hidden) vi.stubEnv('CORRALLM_HIDE_WINDOW', '1');
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await started();

      for (let nth = 0; nth < 4; nth++) {
        cores[nth]?.exit(1);
        await vi.waitFor(() => {
          expect(nth < 3 ? forkCore.mock.calls.length : app.exit.mock.calls.length).toBe(
            nth < 3 ? nth + 2 : 1,
          );
        });
      }
      expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
      const why =
        'corrallm’s core keeps stopping: it stopped 4 times within a minute. Open corrallm again to go on from what was last saved.';
      expect(stderr).toHaveBeenCalledWith(`corrallm: ${why}`);
      if (hidden) expect(showErrorBox).not.toHaveBeenCalled();
      else
        expect(showErrorBox).toHaveBeenCalledExactlyOnceWith('corrallm’s core keeps stopping', why);
    },
  );

  it('is not restarted once the app quits', async () => {
    getAllWindows.mockReturnValue([]);
    await started();
    const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
      event: unknown,
    ) => void;
    beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledOnce();
    });

    cores[0]?.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forkCore).toHaveBeenCalledOnce();
  });
});

it('reports a failed approved core teardown on stderr and exits nonzero, without offering to keep a closed core open', async () => {
  app.whenReady.mockResolvedValueOnce();
  const closed = Promise.withResolvers<{ ok: true; value: null }>();
  request.mockImplementation((name) => {
    if (name === 'commitShutdown') return closed.promise;
    return answered(name);
  });
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await import('./index');
  await vi.waitFor(() => {
    expect(createWindow).toHaveBeenCalledOnce();
  });
  const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
    event: unknown,
  ) => void;
  vi.useFakeTimers();
  beforeQuit({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(9000);
  expect(request).toHaveBeenCalledWith('commitShutdown');
  expect(app.quit).not.toHaveBeenCalled();
  expect(app.exit).not.toHaveBeenCalled();
  closed.reject(new Error('The final journal write failed.'));
  await vi.advanceTimersByTimeAsync(0);
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(app.quit).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(
    'Could not finish closing the core:',
    expect.objectContaining({ message: 'The final journal write failed.' }),
  );
  expect(showMessageBox).not.toHaveBeenCalled();
});

describe('the quit question (B14 C2)', () => {
  async function started(windows: unknown[]) {
    app.whenReady.mockResolvedValueOnce();
    getAllWindows.mockReturnValue(windows);
    await import('./index');
    await vi.waitFor(() => {
      expect(startAppUpdates).toHaveBeenCalledOnce();
    });
  }
  const shutdowns = () =>
    request.mock.calls.filter(([name]) => name === 'prepareShutdown' || name === 'commitShutdown');

  it('asks before a quit while agents work, as a sheet on a window, holding and committing nothing', async () => {
    now.presence = BUSY;
    const window = fakeWindow(7);
    await started([window]);
    const preventDefault = vi.fn();
    handler('before-quit')({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledOnce();
    });
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        message: '2 agents are working.',
        buttons: ['Quit and pause', 'Keep running', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
    expect(shutdowns()).toEqual([]);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('asks before an update’s restart during a run, and installs nothing until answered', async () => {
    now.presence = BUSY;
    const window = fakeWindow(7);
    let restart: (() => void) | undefined;
    const finishQuit = vi.fn(() => true);
    startAppUpdates.mockImplementationOnce((actions) => {
      restart = actions.requestQuit;
      return { finishQuit, cancelRestart: vi.fn(), stop: vi.fn() };
    });
    await started([window]);
    app.quit.mockImplementation(() => {
      handler('before-quit')({ preventDefault: vi.fn() });
    });
    restart?.();
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledOnce();
    });
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ buttons: ['Restart and pause', 'Cancel'], cancelId: 1 }),
    );
    expect(shutdowns()).toEqual([]);
    expect(finishQuit).not.toHaveBeenCalled();
  });

  it('asks about work that started after main last heard, rather than cut it off (the idle race)', async () => {
    // Main's latest presence says idle; by the time the core is asked, a turn has started.
    request.mockImplementation((name, ...args: unknown[]) =>
      name === 'prepareShutdown' && args[1] !== undefined
        ? Promise.resolve({ ok: true, value: { busy: BUSY } })
        : answered(name),
    );
    const window = fakeWindow(7);
    await started([window]);
    handler('before-quit')({ preventDefault: vi.fn() });
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledOnce();
    });
    expect(shutdowns()).toEqual([['prepareShutdown', 'quit', { ifIdle: true }]]);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('on Linux, asks as the last window closes during a run, with the window still open', async () => {
    await onPlatform('linux', async () => {
      now.presence = BUSY;
      const window = fakeWindow(7);
      await started([window]);
      handler('browser-window-created')({}, window);
      showMessageBox.mockResolvedValueOnce({ response: 1 }); // Keep running
      const preventDefault = vi.fn();
      window.emit('close', { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(window.minimize).toHaveBeenCalledOnce();
      });
      expect(showMessageBox).toHaveBeenCalledWith(
        window,
        expect.objectContaining({
          detail: expect.stringContaining(
            'Keep running minimizes corrallm; the agents go on.',
          ) as string,
        }),
      );
      expect(window.close).not.toHaveBeenCalled();
      expect(app.quit).not.toHaveBeenCalled();
      expect(shutdowns()).toEqual([]);
    });
  });

  it('takes a core that closes itself (exiting) through the system path: no question, then quits', async () => {
    now.presence = BUSY;
    const window = fakeWindow(7);
    await started([window]);
    cores[0]?.emit('exiting', 'signal');
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledOnce();
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([name, ...args]) => [name, ...args])).toEqual([
      ['init', expect.anything()],
      ['flushDrafts', [7], 'system'],
      ['prepareShutdown', 'system'],
      ['commitShutdown'],
    ]);
    expect(app.exit).not.toHaveBeenCalled();
  });

  it('quits through the system path when its core exits 0 unasked, rather than sit with no core', async () => {
    const window = fakeWindow(7);
    await started([window]);
    request.mockImplementation((name) =>
      name === 'init'
        ? answered(name)
        : Promise.reject(new Error('the core process exited with code 0')),
    );
    cores[0]?.exit(0);
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledOnce();
    });
    expect(forkCore).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('prevents the system’s shutdown or logout (powerMonitor) and quits itself, asking nothing', async () => {
    now.presence = BUSY;
    const window = fakeWindow(7);
    await started([window]);
    const preventDefault = vi.fn();
    handler('shutdown', powerMonitor)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledOnce();
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('prepareShutdown', 'system');
  });
});
