import { expect, test } from '@playwright/test';

import { continuityWorld } from './continuity-world';
import { crashRenderer } from './crash-renderer';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');

// One case per connection mode, each losing its view a different way: a reload and a renderer
// crash both end only the view, so each loss and each mode's view coming back is checked once.
// The core-only counterpart (src/main/core/app.test.ts) drops every window and subscription
// mid-turn and sees the same native session finish.
for (const [terminal, loss] of [
  [false, 'reload'],
  [true, 'renderer crash'],
] as const) {
  test(`${terminal ? 'Terminal' : 'SDK'}: ${loss} preserves the turn, its condition and next task`, async () => {
    const world = await continuityWorld({ terminal });
    try {
      await world.start();
      const sessions = await world.sessions();
      if (loss === 'reload') await world.page.reload();
      else {
        await crashRenderer(world.app, world.page);
        // Playwright keeps a crashed page dead even when its window reloads, so the view is
        // recovered as a user does: the dead window closed, a new one opened. A renderer death
        // must not restart the utility core, whose run goes on beneath either.
        await world.closeWindow({ destroy: true });
        await world.reopen();
      }
      await world.showQueues();
      await expect(world.row('first')).toHaveAttribute('data-run', 'running');
      expect(await world.sessions()).toEqual(sessions);
      expect(await world.prompts()).toEqual(['continuity-first']);
      await world.release();
      await world.completed();
    } catch (error) {
      // Preserve the original operation if cleanup fails too.
      console.error('Continuity scenario failed before closing:', error);
      throw error;
    } finally {
      await world.close();
    }
  });
}
