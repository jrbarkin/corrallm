import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { expect, test } from '@playwright/test';

import { launchApp } from './launch';

test('launches, renders the window and round-trips app:ping', async () => {
  const { app, close } = await launchApp();
  try {
    const page = await app.firstWindow();

    // Production build: served from the app:// scheme with the strict CSP.
    await expect(page).toHaveURL(/^app:\/\/main_window\//);
    await expect(page.getByRole('heading', { level: 1, name: 'corrallm' })).toBeVisible();

    const ping = page.getByTestId('ping-result');
    await expect(ping).toHaveAttribute('data-status', 'ok');
    await expect(ping).toHaveText(/^corrallm \d+\.\d+\.\d+ \(Electron /);

    // Context isolation + sandbox: no Node globals leak into the renderer.
    const leaked = await page.evaluate(() => ({
      require: 'require' in globalThis,
      process: 'process' in globalThis,
    }));
    expect(leaked).toEqual({ require: false, process: false });

    // The window under test stays hidden: it never pops up on screen or meets the real mouse.
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.isVisible()),
      ),
    ).toEqual([false]);

    // A throwaway profile: state the real app saved (such as a page zoom) must not leak in.
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    expect(userData.startsWith(realpathSync(tmpdir()))).toBe(true);
  } finally {
    await close();
  }
});
