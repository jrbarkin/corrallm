import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { app, registerPrivileges, installGuards } = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    enableSandbox: vi.fn(),
    on: vi.fn(),
  },
  registerPrivileges: vi.fn(),
  installGuards: vi.fn(),
}));

// Bootstrap is tested before readiness, so it cannot start sessions or write user data.
vi.mock('electron', () => ({
  app,
  BrowserWindow: {},
  dialog: {},
  session: {},
  shell: {},
  ipcMain: {},
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
vi.mock('./sessions/connectors', () => ({ createConnectors: vi.fn(), createOptions: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  app.requestSingleInstanceLock.mockReturnValue(true);
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  vi.stubEnv('CORRALLM_NATIVE_SELFTEST', undefined);
  vi.stubEnv('CORRALLM_HIDE_WINDOW', undefined);
});

afterEach(() => {
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
