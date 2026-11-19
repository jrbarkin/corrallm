import { expect, test } from '@playwright/test';

import { openNeeds } from './canvas-actions';
import { connectionName } from './catalog';
import { continuityWorld } from './continuity-world';

test('an outside connection change waits for your approval in Needs, then opens the new connection', async () => {
  const world = await continuityWorld({ fakeSessions: true, queue: [] });
  try {
    const args = { canvas: world.canvas, agent: 'builder' };
    await world.call('session.open', args);
    await expect
      .poll(async () => (await world.call('session.get', args)).connection, {
        message: 'The original session must be ready on its own SDK connection',
      })
      .toBe('claude-code.sdk');
    const proposed = await world.call('agent.setConnection', {
      ...args,
      connection: 'claude-code.terminal',
    });
    expect(
      proposed,
      'The token must propose, rather than apply, the connection change',
    ).toHaveProperty('proposed');
    if (!('proposed' in proposed)) throw new Error('No proposal returned');
    expect(
      (await world.call('canvas.get', { canvas: world.canvas })).nodes[0]?.data.connection,
      'Proposing must leave the original connection unchanged',
    ).toBe('claude-code.sdk');
    expect(
      (
        await world.raw('reply', {
          canvas: world.canvas,
          to: proposed.proposed,
          answer: { choice: 'allow' },
        })
      ).isError,
      'The token must never approve its own proposal',
    ).toBe(true);
    await openNeeds(world.page);
    const card = world.page.getByRole('article', { name: /asks to change the backend of Builder/ });
    await expect(
      card,
      'Needs must identify both endpoints in order, including their model and effort defaults',
    ).toContainText(
      `Change Builder’s backend from ${connectionName('claude-code.sdk')} (model: native default, effort: native default) to ${connectionName('claude-code.terminal')} (model: native default, effort: native default).`,
    );
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await world.call('canvas.get', { canvas: world.canvas })).nodes[0]?.data.connection,
        {
          message: 'Only the person’s Allow must commit the new connection',
        },
      )
      .toBe('claude-code.terminal');
    await world.call('session.open', args);
    await expect
      .poll(
        async () => {
          const session = await world.call('session.get', args);
          return { connection: session.connection, ready: session.features !== null };
        },
        { message: 'The reopened agent must be ready on the approved Terminal connection' },
      )
      .toEqual({ connection: 'claude-code.terminal', ready: true });
  } finally {
    await world.close();
  }
});
