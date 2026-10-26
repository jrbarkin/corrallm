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
          // Playwright keeps a crashed page dead even when its window reloads, so the view is
          // recovered as a user does: the dead window closed, a new one opened. A renderer death
          // must not restart the utility core, whose run goes on beneath either.
          await world.closeWindow();
          await world.reopen();
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
