import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Closes the app's only window while work goes on, and answers corrallm's quit question Keep
 * running (B14 C2/C4). On macOS Keep running closes every window; on Linux and Windows it
 * minimizes them, so the window survives. Asserts which happened.
 *
 * `destroy` is for a window that cannot be closed politely (a crashed renderer Playwright keeps
 * dead): it is destroyed instead. On Linux and Windows that is also a last window, so the
 * question comes on a new one, which Keep running minimizes; that window's page is returned,
 * for `reopenWindow`.
 */
export async function closeLastWindow(
  app: ElectronApplication,
  page: Page,
  options: { destroy?: boolean } = {},
): Promise<Page | undefined> {
  const destroy = options.destroy === true;
  if (process.platform === 'darwin') {
    const closed = page.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }, destroying) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (destroying) window?.destroy();
      else window?.close();
    }, destroy);
    await closed;
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    return undefined;
  }
  const successor = destroy ? app.waitForEvent('window', { timeout: 15_000 }) : undefined;
  // One answer: Keep running, then launchApp's Quit and pause answer is back. The windows are
  // hidden by the harness (and Xvfb has no window manager to report a minimized state), so
  // minimize() is observed by wrapping the call, which still runs.
  await app.evaluate(({ dialog, BrowserWindow }, destroying) => {
    const answering = dialog.showMessageBox.bind(dialog);
    const seen = globalThis as { minimized?: number };
    seen.minimized = 0;
    const prototype = BrowserWindow.prototype;
    const original: unknown = Reflect.get(prototype, 'minimize');
    const minimize = original as (this: unknown) => void;
    prototype.minimize = function (this: Electron.BrowserWindow) {
      seen.minimized = (seen.minimized ?? 0) + 1;
      minimize.call(this);
    };
    Object.assign(dialog, {
      showMessageBox: (...args: unknown[]) => {
        const asked = args.at(-1) as { buttons?: string[] } | undefined;
        if (asked?.buttons?.[0] !== 'Quit and pause') {
          return Reflect.apply(answering, dialog, args) as ReturnType<typeof answering>;
        }
        Object.assign(dialog, { showMessageBox: answering });
        return Promise.resolve({ response: asked.buttons.indexOf('Keep running') });
      },
    });
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error('No window to close');
    if (destroying) window.destroy();
    else window.close();
  }, destroy);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => ({
        minimized: (globalThis as { minimized?: number }).minimized,
        windows: BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
      })),
    )
    .toEqual({ minimized: 1, windows: 1 });
  return await successor;
}

/**
 * Brings the window back as a second launch does: a new one on macOS, the minimized one
 * elsewhere (`current`, or the successor `closeLastWindow` returned).
 */
export async function reopenWindow(
  app: ElectronApplication,
  current: Page,
  successor?: Page,
): Promise<Page> {
  if (process.platform === 'darwin') {
    const opened = app.waitForEvent('window');
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
    return opened;
  }
  await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
  return successor ?? current;
}
