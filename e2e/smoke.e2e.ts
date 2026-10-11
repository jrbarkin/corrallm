import { _electron as electron, expect, test } from '@playwright/test';

test('launches, renders the window and round-trips app:ping', async () => {
  // '.' resolves package.json "main" (.vite/build/main.cjs).
  const app = await electron.launch({ args: ['.'] });
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
  } finally {
    await app.close();
  }
});
