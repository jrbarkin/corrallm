import type { ElectronApplication, Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';

import { closeLastWindow } from '../../e2e/last-window';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'waits for the native window to leave after its page closes (destroy %s)',
  async (destroy) => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const pageClosed = Promise.withResolvers<undefined>();
    const waitForEvent = vi.fn(() => pageClosed.promise);
    let removed = false;
    const close = vi.fn(() => {
      expect(waitForEvent).toHaveBeenCalledWith('close');
      pageClosed.resolve(undefined);
    });
    const window = { close, destroy: close };
    const getAllWindows = vi.fn(() => (removed ? [] : [window]));
    const app = {
      evaluate: (body: (electron: unknown, arg: unknown) => unknown, arg: unknown) =>
        Promise.resolve(body({ BrowserWindow: { getAllWindows } }, arg)),
    } as unknown as ElectronApplication;
    const page = { waitForEvent } as unknown as Page;
    const settled = vi.fn();
    const outcome = closeLastWindow(app, page, { destroy }).then(
      (value) => {
        settled('closed');
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled('failed');
        return { ok: false as const, error };
      },
    );
    try {
      // Playwright has heard its page close, but Electron still lists its native window.
      await vi.waitFor(() => {
        expect(getAllWindows.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      expect(close).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      removed = true;
      await expect(outcome).resolves.toEqual({ ok: true, value: undefined });
    } finally {
      removed = true;
      await outcome;
    }
  },
);
