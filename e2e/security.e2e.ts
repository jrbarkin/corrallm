import { expect, test } from '@playwright/test';

import { launchApp } from './launch';

test('blocks renderer navigation, new windows and media permissions', async () => {
  const { app, close } = await launchApp({
    env: { CORRALLM_FAKE_SESSIONS: '1' },
    // A permission regression must not reach real hardware or pass because the OS refused it.
    args: ['--use-fake-device-for-media-stream'],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await expect(page.getByRole('heading', { level: 1, name: 'corrallm' })).toBeVisible();
    const rendererUrl = page.url();

    // Stub OS dispatch: allowlisted links are still tested, without opening a real browser.
    const externalLinks = await app.evaluateHandle(({ shell }) => {
      const links: string[] = [];
      shell.openExternal = (url) => {
        links.push(url);
        return Promise.resolve();
      };
      return links;
    });
    const navigation = await app.evaluateHandle(({ BrowserWindow }) => ({
      result: new Promise<{ url: string; blocked: boolean }>((resolve) => {
        BrowserWindow.getAllWindows()[0]?.webContents.once('will-navigate', (event) => {
          resolve({ url: event.url, blocked: event.defaultPrevented });
        });
      }),
    }));
    await page.evaluate(() => {
      window.location.href = 'https://attacker.invalid/leave';
    });
    expect(await navigation.evaluate(({ result }) => result)).toEqual({
      url: 'https://attacker.invalid/leave',
      blocked: true,
    });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
      ),
    ).toBe(rendererUrl);

    expect(await page.evaluate(() => window.open('https://attacker.invalid/popup'))).toBeNull();
    expect(await externalLinks.evaluate((links) => links)).toEqual([]);
    expect(await page.evaluate(() => window.open('https://github.com/corrallm-test'))).toBeNull();
    expect(await externalLinks.evaluate((links) => links)).toEqual([
      'https://github.com/corrallm-test',
    ]);
    expect(app.windows()).toHaveLength(1);

    const media = await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        for (const track of stream.getTracks()) track.stop();
        return 'granted';
      } catch (error) {
        return error instanceof DOMException ? error.name : String(error);
      }
    });
    expect(media).toBe('NotAllowedError');
    expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe('corrallm');
    await navigation.dispose();
    await externalLinks.dispose();
  } finally {
    await close();
  }
});
