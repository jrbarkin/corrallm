import { expect, test } from '@playwright/test';

import { agentApiWorld } from './agent-api-world';
import { openNeeds } from './canvas-actions';

test.skip(process.platform === 'win32', 'The native fakes use POSIX wrappers.');
test.setTimeout(120_000);

/*
 * B19 X4: a queue hands a task to another agent in the built app, on fake CLIs only. The recipient
 * stands at an OK of its own, so the hand-off waits for it: it shows as a read-only row in the
 * recipient's queue, from its sender. Once you answer the OK, it is delivered, its reply is the
 * sender's evidence (the sender is run no turn for it), and the sender's own OK is answered in turn.
 * The decisions are settled lines in each agent's window: in a connected agent's transcript, and in
 * a Terminal agent's bar. No gesture here sends more than one operation.
 */

test('a hand-off waits for its recipient’s OK as a read-only row, and your decisions settle in each window', async () => {
  const world = await agentApiWorld({
    agents: [
      {
        id: 'lead',
        label: 'Lead',
        connection: 'claude-code.terminal',
        queue: [
          { id: 'hand', message: 'review-this-please', target: 'worker' },
          { id: 'sign', approve: 'the review' },
        ],
      },
      {
        id: 'worker',
        label: 'Worker',
        connection: 'claude-code.sdk',
        queue: [{ id: 'gate', approve: 'the gate' }],
      },
    ],
    links: [['lead', 'worker']],
    rules: [{ when: 'review-this-please', reply: 'Looks right.\nAPPROVED' }],
  });
  try {
    const { page } = world;
    await world.run();

    // The worker stands at its OK: the lead's hand-off waits, read-only, from the lead.
    await expect(world.row('worker', 'gate')).toBeVisible({ timeout: 20_000 });
    const handoff = world
      .queues()
      .locator('.graph-queue-submission[data-handoff="Lead"]')
      .filter({ hasText: 'review-this-please' });
    await expect(handoff).toHaveCount(1, { timeout: 20_000 });
    await expect(handoff).toContainText('From Lead');
    await expect(handoff.locator('button, textarea, input')).toHaveCount(0);
    expect(await world.sdkPrompts()).toEqual([]);

    // Answer the worker's OK: the hand-off goes, and its reply is the lead's evidence.
    await openNeeds(page);
    const needs = page.getByRole('complementary', { name: 'Needs you' });
    await needs
      .getByRole('article')
      .filter({ hasText: 'the gate' })
      .getByRole('button', { name: 'Approve' })
      .click();
    await expect
      .poll(
        async () => (await world.sdkPrompts()).some((text) => text.includes('review-this-please')),
        {
          timeout: 20_000,
        },
      )
      .toBe(true);
    await expect(world.row('lead', 'hand')).toHaveAttribute('data-run', 'succeeded', {
      timeout: 20_000,
    });
    await expect(handoff).toHaveCount(0);
    // The lead ran no turn of the reply: its terminal was sent nothing.
    expect(
      (await world.terminalLog()).filter((line) => line.event === 'prompt' && line.text),
    ).toEqual([]);

    // Answer the lead's own OK.
    await needs
      .getByRole('article')
      .filter({ hasText: 'the review' })
      .getByRole('button', { name: 'Approve' })
      .click();
    await expect(world.row('lead', 'sign')).toHaveAttribute('data-run', 'succeeded', {
      timeout: 20_000,
    });

    // Each decision is a settled line in its agent's window: a connected agent's transcript...
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Worker,/ }).click();
    await expect(
      page.getByRole('log', { name: 'Transcript' }).getByRole('note').filter({
        hasText: 'Approved by you.',
      }),
    ).toHaveCount(1);
    // ...and a Terminal agent's bar, hideable for this view alone.
    await page.getByRole('button', { name: /^Lead,/ }).click();
    const settled = page.getByRole('group', { name: 'Settled' });
    await expect(settled.getByRole('note')).toHaveText('Approved by you.');
    await settled.getByRole('button', { name: 'Hide' }).click();
    await expect(settled).toHaveCount(0);
  } finally {
    await world.close();
  }
});
