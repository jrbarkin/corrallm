import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import type { RunShutdown } from './run-shutdown';
import { AppUpdates } from './updates';
import type { UpdateEvents } from './updates';
import type { AppUpdateActions } from './host/updates';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  app,
  powerMonitor,
  registerPrivileges,
  installGuards,
  getAllWindows,
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
    commandLine: { hasSwitch: vi.fn(() => false) },
  },
  powerMonitor: { on: vi.fn() },
  getAllWindows: vi.fn<() => unknown[]>(() => []),
  showMessageBox: vi.fn(() => new Promise<{ response: number }>(() => undefined)),
  showErrorBox: vi.fn(),
  registerPrivileges: vi.fn(),
  installGuards: vi.fn(),
}));

// The core and windows are faked: boot and closing never start sessions or write user data.
vi.mock('electron', () => ({
  app,
  powerMonitor,
  BrowserWindow: { getAllWindows },
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
const { request, createWindow, makeHost, forkCore, cores, reconnect } = vi.hoisted(() => {
  const request = vi.fn<
    (name: string, ...args: unknown[]) => Promise<{ ok: true; value: unknown }>
  >(() => Promise.resolve({ ok: true, value: null }));
  /** Each core process forked: how to end it, as a crash would. */
  const cores: { exit: (code: number) => void }[] = [];
  return {
    request,
    createWindow: vi.fn(() => Promise.resolve()),
    makeHost: vi.fn<(_shutdown: Pick<RunShutdown, 'ready'>) => unknown>(() => ({})),
    cores,
    forkCore: vi.fn(() => {
      const exited = Promise.withResolvers<number>();
      cores.push({ exit: exited.resolve });
      return {
        link: { request },
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getAllWindows.mockReturnValue([]);
  cores.splice(0);
  request.mockReset();
  request.mockResolvedValue({ ok: true, value: null });
  app.requestSingleInstanceLock.mockReturnValue(true);
  app.quit.mockReset();
  app.isPackaged = false;
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
      const flushed = Promise.withResolvers<{ ok: true; value: null }>();
      const closed = Promise.withResolvers<{ ok: true; value: null }>();
      request.mockImplementation((name) =>
        name === 'flush'
          ? flushed.promise
          : name === 'close'
            ? closed.promise
            : Promise.resolve({ ok: true, value: name === 'shown' ? [7] : null }),
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
      await vi.waitFor(() => {
        expect(contents.send).toHaveBeenCalledOnce();
      });
      expect(app.quit).toHaveBeenCalledOnce(); // Never a second request that forces Closing to abandon.
      expect(install).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([name]) => name)).toEqual(['init', 'shown']);
      makeHost.mock.calls[0]?.[0].ready(
        contents as unknown as WebContents,
        contents.send.mock.calls[0]?.[1] as string,
        null,
      );
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith('flush');
      });
      expect(install).not.toHaveBeenCalled();
      flushed.resolve({ ok: true, value: null });
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith('close');
      });
      expect(install).not.toHaveBeenCalled();
      closed.resolve({ ok: true, value: null });
      await vi.waitFor(() => {
        expect(install).toHaveBeenCalledOnce();
      });
      expect(request.mock.calls.map(([name]) => name)).toEqual(['init', 'shown', 'flush', 'close']);
      updates?.stop();
    },
  );

  it.each(['renderer', 'core'])(
    'never installs when %s saving fails and Keep corrallm open is chosen',
    async (where) => {
      app.whenReady.mockResolvedValueOnce();
      showMessageBox.mockResolvedValueOnce({ response: 0 });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
      getAllWindows.mockReturnValue([{ webContents: contents }]);
      request.mockImplementation((name) =>
        name === 'flush'
          ? Promise.reject(new Error('Disk full'))
          : Promise.resolve({ ok: true, value: name === 'shown' ? [7] : null }),
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
        expect(contents.send).toHaveBeenCalledOnce();
      });
      makeHost.mock.calls[0]?.[0].ready(
        contents as unknown as WebContents,
        contents.send.mock.calls[0]?.[1] as string,
        where === 'renderer' ? 'Disk full' : null,
      );
      await vi.waitFor(() => {
        expect(cancelRestart).toHaveBeenCalledOnce();
      });
      expect(showMessageBox).toHaveBeenCalledOnce();
      expect(finishQuit).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([name]) => name)).toEqual(
        where === 'renderer' ? ['init', 'shown'] : ['init', 'shown', 'flush'],
      );
    },
  );
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
        showMessageBox.mockResolvedValueOnce({ response: 1 });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
      }
      let coreClosed = false;
      request.mockImplementation((name) => {
        if (name === 'close')
          return new Promise((resolve) => {
            setTimeout(() => {
              coreClosed = true;
              resolve({ ok: true, value: null });
            }, 9000);
          });
        if (name === 'flush' && anyway) return Promise.reject(new Error('Disk full'));
        return Promise.resolve({ ok: true, value: name === 'shown' ? [] : null });
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
      expect(request).toHaveBeenCalledWith('close');
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
      expect(request.mock.calls.filter(([name]) => name === 'close')).toHaveLength(1);
    },
  );

  it('keeps the five-second escape for an explicit second quit while saving hangs', async () => {
    app.whenReady.mockResolvedValueOnce();
    request.mockImplementation((name) => {
      if (name === 'flush' || name === 'close') return new Promise(() => undefined);
      return Promise.resolve({ ok: true, value: name === 'shown' ? [] : null });
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
    expect(request).toHaveBeenCalledWith('flush');
    beforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(4999);
    expect(app.quit).not.toHaveBeenCalled();
    expect(finishQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(finishQuit).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([name]) => name === 'close')).toHaveLength(1);
  });
});

describe('quit races', () => {
  function beforeQuit() {
    const callback = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as
      ((event: { preventDefault(): void }) => void) | undefined;
    if (!callback) throw new Error('No quit handler');
    return callback;
  }

  it('blocks a repeated before-quit until the approved core close has completed', async () => {
    app.whenReady.mockResolvedValueOnce();
    const window = Object.assign(new EventEmitter(), { webContents: { id: 7 }, close: vi.fn() });
    getAllWindows.mockReturnValue([window]);
    const closed = Promise.withResolvers<{ ok: true; value: null }>();
    request.mockImplementation((name) =>
      name === 'close'
        ? closed.promise
        : Promise.resolve({ ok: true, value: name === 'shown' ? [] : null }),
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
    expect(request).toHaveBeenCalledWith('close');
    const preventDefault = vi.fn();
    quit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const windowClose = vi.fn();
    window.emit('close', { preventDefault: windowClose });
    expect(windowClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9000);
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
    expect(request.mock.calls.filter(([name]) => name === 'close')).toHaveLength(1);
  });

  it.each(['resolves', 'rejects'])(
    'does not let a window save that %s override an approved app quit',
    async (outcome) => {
      vi.stubEnv('CORRALLM_HIDE_WINDOW', '1');
      app.whenReady.mockResolvedValueOnce();
      const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
      const window = Object.assign(new EventEmitter(), { webContents: contents, close: vi.fn() });
      getAllWindows.mockReturnValue([window]);
      const windowSave = Promise.withResolvers<{ ok: true; value: null }>();
      const closed = Promise.withResolvers<{ ok: true; value: null }>();
      let flushes = 0;
      request.mockImplementation((name) => {
        if (name === 'flush' && ++flushes === 1) return windowSave.promise;
        if (name === 'close') return closed.promise;
        return Promise.resolve({ ok: true, value: name === 'shown' ? [] : null });
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
      expect(request).toHaveBeenCalledWith('close');
      if (outcome === 'rejects') windowSave.reject(new Error('The core is closing.'));
      else windowSave.resolve({ ok: true, value: null });
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
        name === 'close'
          ? closed.promise
          : Promise.resolve({ ok: true, value: name === 'shown' ? [] : null }),
      );
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await import('./index');
      await vi.waitFor(() => {
        expect(createWindow).toHaveBeenCalledOnce();
      });
      vi.useFakeTimers();
      beforeQuit()({ preventDefault: vi.fn() }); // firstWindow() does not wait for loadURL to finish.
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith('close');
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
        Promise.resolve({ ok: true, value: name === 'shown' ? [7] : null }),
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

      expect(contents.send).toHaveBeenCalledWith('run:stopping', expect.any(String));
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        'Could not save before closing:',
        'The window did not finish saving its run before closing',
      );
      expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(preventDefault).toHaveBeenCalledOnce();
    },
  );
});

it('keeps the core up until the window has finished saving and main receives run:ready', async () => {
  app.whenReady.mockResolvedValueOnce();
  const contents = { id: 7, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() };
  getAllWindows.mockReturnValue([{ webContents: contents }]);
  request.mockImplementation((name) =>
    Promise.resolve({ ok: true, value: name === 'shown' ? [7] : null }),
  );
  await import('./index');
  await vi.waitFor(() => {
    expect(createWindow).toHaveBeenCalledOnce();
  });
  const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
    event: unknown,
  ) => void;
  beforeQuit({ preventDefault: vi.fn() });
  await vi.waitFor(() => {
    expect(contents.send).toHaveBeenCalledOnce();
  });
  expect(request.mock.calls.map(([name]) => name)).toEqual(['init', 'shown']);
  expect(app.quit).not.toHaveBeenCalled();
  const shutdown = makeHost.mock.calls[0]?.[0];
  if (!shutdown) throw new Error('no shutdown service');
  shutdown.ready(
    contents as unknown as WebContents,
    contents.send.mock.calls[0]?.[1] as string,
    null,
  );
  await vi.waitFor(() => {
    expect(app.quit).toHaveBeenCalledOnce();
  });
  expect(request.mock.calls.map(([name]) => name)).toEqual(['init', 'shown', 'flush', 'close']);
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
    if (name === 'close') return closed.promise;
    return Promise.resolve({ ok: true, value: name === 'shown' ? [] : null });
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
  expect(request).toHaveBeenCalledWith('close');
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
