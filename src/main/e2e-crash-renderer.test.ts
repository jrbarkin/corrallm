import { EventEmitter } from 'node:events';

import type { ElectronApplication, Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';

import { crashRenderer } from '../../e2e/crash-renderer';

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(['playwright', 'electron'] as const)(
  'waits for both renderer crash notifications when %s reports it first',
  async (first) => {
    const renderer = process.pid + 100;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const contents = Object.assign(new EventEmitter(), {
      getOSProcessId: () => renderer,
      forcefullyCrashRenderer: vi.fn(),
    });
    const crashed = Promise.withResolvers<undefined>();
    const page = { waitForEvent: vi.fn(() => crashed.promise) } as unknown as Page;
    const evaluate = vi.fn((callback: (electron: unknown) => Promise<unknown>) =>
      callback({ BrowserWindow: { getAllWindows: () => [{ webContents: contents }] } }),
    );
    const app = { evaluate } as unknown as ElectronApplication;
    let complete = false;
    const waiting = crashRenderer(app, page).then(() => {
      complete = true;
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(renderer, 'SIGKILL');
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    const report = (who: string) => {
      if (who === 'playwright') crashed.resolve(undefined);
      else contents.emit('render-process-gone', {}, { reason: 'crashed' });
    };
    report(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(complete).toBe(false);
    report(first === 'playwright' ? 'electron' : 'playwright');
    await waiting;
    expect(complete).toBe(true);
    expect(contents.listenerCount('render-process-gone')).toBe(0);
  },
);

it.each([0, -1, Number.NaN, process.pid])(
  'refuses renderer process id %s before signalling',
  async (pid) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const contents = Object.assign(new EventEmitter(), { getOSProcessId: () => pid });
    const evaluate = (callback: (electron: unknown) => Promise<unknown>) =>
      callback({ BrowserWindow: { getAllWindows: () => [{ webContents: contents }] } });
    const app = { evaluate } as unknown as ElectronApplication;
    const page = { waitForEvent: () => Promise.resolve() } as unknown as Page;
    await expect(crashRenderer(app, page)).rejects.toThrow('No separate renderer process');
    expect(kill).not.toHaveBeenCalled();
    expect(contents.listenerCount('render-process-gone')).toBe(0);
  },
);

it('removes its native listener if the renderer signal fails', async () => {
  const error = new Error('The renderer signal failed');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw error;
  });
  const contents = Object.assign(new EventEmitter(), { getOSProcessId: () => process.pid + 100 });
  const evaluate = (callback: (electron: unknown) => Promise<unknown>) =>
    callback({ BrowserWindow: { getAllWindows: () => [{ webContents: contents }] } });
  const app = { evaluate } as unknown as ElectronApplication;
  const page = { waitForEvent: () => Promise.resolve() } as unknown as Page;
  await expect(crashRenderer(app, page)).rejects.toBe(error);
  expect(contents.listenerCount('render-process-gone')).toBe(0);
});
