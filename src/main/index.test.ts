import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import type { RunShutdown } from './run-shutdown';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { app, registerPrivileges, installGuards, getAllWindows, showMessageBox, showErrorBox } =
  vi.hoisted(() => ({
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
    getAllWindows: vi.fn<() => unknown[]>(() => []),
    showMessageBox: vi.fn(() => new Promise<{ response: number }>(() => undefined)),
    showErrorBox: vi.fn(),
    registerPrivileges: vi.fn(),
    installGuards: vi.fn(),
  }));

// The core and windows are faked: boot and closing never start sessions or write user data.
vi.mock('electron', () => ({
  app,
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
  app.isPackaged = false;
  app.whenReady.mockImplementation(() => new Promise<void>(() => undefined));
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubGlobal('CORRALLM_DISTRIBUTION', 'local');
  vi.stubEnv('CORRALLM_NATIVE_SELFTEST', undefined);
  vi.stubEnv('CORRALLM_HIDE_WINDOW', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

it('finishes an approved quit if teardown fails, without offering to keep a closed core open', async () => {
  app.whenReady.mockResolvedValueOnce();
  request.mockImplementation((name) => {
    if (name === 'close') return Promise.reject(new Error('The final journal write failed.'));
    return Promise.resolve({ ok: true, value: name === 'shown' ? [] : null });
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await import('./index');
  await vi.waitFor(() => {
    expect(createWindow).toHaveBeenCalledOnce();
  });
  const beforeQuit = app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as (
    event: unknown,
  ) => void;
  beforeQuit({ preventDefault: vi.fn() });
  await vi.waitFor(() => {
    expect(app.quit).toHaveBeenCalledOnce();
  });
  expect(showMessageBox).not.toHaveBeenCalled();
});
