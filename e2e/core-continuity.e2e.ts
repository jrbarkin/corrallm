import { expect, test } from '@playwright/test';

import { continuityWorld } from './continuity-world';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');

for (const terminal of [false, true]) {
  for (const loss of ['reload', 'renderer crash'] as const) {
    test(`${terminal ? 'Terminal' : 'SDK'}: ${loss} preserves the turn, its condition and next task`, async () => {
      const world = await continuityWorld({ terminal });
      try {
        await world.start();
        const sessions = await world.sessions();
        if (loss === 'reload') await world.page.reload();
        else {
          const crashed = world.page.waitForEvent('crash');
          await world.app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
          });
          await crashed;
          // Recover only the view. A renderer death must not restart the utility core.
          const reloaded = world.page.waitForEvent('load');
          await world.app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]?.webContents.reload();
          });
          await reloaded;
        }
        await world.showQueues();
        await expect(world.row('first')).toHaveAttribute('data-run', 'running');
        expect(await world.sessions()).toEqual(sessions);
        expect(await world.prompts()).toEqual(['continuity-first']);
        await world.release();
        await world.completed();
      } finally {
        await world.close();
      }
    });
  }
}
