import { expect, test } from '@playwright/test';

import { continuityWorld } from './continuity-world';
import { canvasAction } from './canvas-actions';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');

for (const terminal of [false, true]) {
  test(`${terminal ? 'Terminal' : 'SDK'}: with no window, the core finishes its run and serves MCP; reopening keeps the session`, async () => {
    const world = await continuityWorld({ terminal });
    try {
      await world.start();
      const sessions = await world.sessions();
      await world.closeWindow();
      // The actual outside endpoint reads and accepts work with no renderer in the app.
      const state = await world.call('run.get', { canvas: world.canvas });
      expect(state).toMatchObject({ running: true });
      expect(
        await world.call('session.get', { canvas: world.canvas, agent: 'builder' }),
      ).toMatchObject({
        status: 'working',
      });
      await world.release();
      await expect
        .poll(world.prompts, { timeout: 15_000 })
        .toEqual(['continuity-first', 'continuity-condition', 'continuity-next']);
      await expect
        .poll(
          async () =>
            Object.values((await world.call('run.get', { canvas: world.canvas })).agents)[0]
              ?.status,
        )
        .toBe('done');
      const sent = await world.call('message', {
        canvas: world.canvas,
        to: 'builder',
        body: 'outside-with-no-window',
      });
      expect(sent).toHaveProperty('id');
      await expect
        .poll(async () => (await world.call('messages', { canvas: world.canvas })).items, {
          timeout: 15_000,
        })
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ id: sent.id, state: 'replied' })]),
        );
      expect((await world.prompts()).at(-1)).toContain('outside-with-no-window');
      expect(await world.sessions()).toEqual(sessions);
      expect((await world.discovery()).pid).toBe(world.endpoint.pid);
      await world.reopen();
      await expect(world.page.locator('.react-flow__node-agent')).toHaveCount(1);
      await canvasAction(world.page, 'New');
      await canvasAction(world.page, 'Canvases');
      const list = world.page.getByRole('dialog', { name: 'Canvases', exact: true });
      const kept = list.getByRole('listitem').filter({ hasText: 'continuity.corral' });
      await expect(kept).toContainText('Open');
      await expect(kept.getByText('Running', { exact: true })).toHaveCount(0);
      await kept.getByRole('button', { name: 'Show continuity.corral', exact: true }).click();
      // The canvas menu, and the Canvases list in it, stay open over the dock until dismissed.
      const menu = world.page.getByRole('button', { name: 'Canvas menu', exact: true });
      if ((await menu.getAttribute('aria-expanded')) === 'true') await menu.click();
      await expect(list).toBeHidden();
      await world.showQueues();
      for (const id of ['first', 'check', 'branch', 'next']) {
        await expect(world.row(id)).toHaveAttribute('data-run', 'succeeded');
      }
      await expect(world.queues().getByRole('status')).toHaveText('All done');
      expect(await world.prompts()).toHaveLength(4);
      expect(await world.sessions()).toEqual(sessions);
    } finally {
      await world.close();
    }
  });
}
