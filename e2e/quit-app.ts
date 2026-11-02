import type { ElectronApplication } from '@playwright/test';

/** Finish corrallm's drafts and core shutdown before Playwright tears down its context. */
export async function quitApp(app: ElectronApplication): Promise<void> {
  try {
    await app.evaluate(
      ({ app }) =>
        new Promise<void>((resolve) => {
          app.once('will-quit', (event) => {
            // The app has approved quit and closed its core. Retain the inspector until cleanup.
            event.preventDefault();
            resolve();
          });
          app.quit();
        }),
    );
  } finally {
    await app.close();
  }
}
