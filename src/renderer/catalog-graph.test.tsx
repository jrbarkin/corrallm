import { screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { MADE_UP } from '../shared/test-made-up';
import { useCatalog } from './test-catalog';
import { GraphEditor } from './test-graph';
import { events, renderReady } from './test-render';
import { expectOneOp } from './test-api';
import type { FakeCanvas } from './test-canvas';

vi.mock('./terminal/screen', async () => ({
  createScreen: (await import('./terminal/test-screen')).fakeScreens.create,
}));

it('projects an unfamiliar connection on the card, dock and settings and offers its queue actions', async () => {
  await useCatalog(MADE_UP);
  let canvas: FakeCanvas | undefined;
  const { container } = await renderReady(
    <GraphEditor
      initialGraph={{
        nodes: [
          {
            id: 'worker',
            type: 'agent',
            position: { x: 0, y: 0 },
            data: { label: 'Worker', adapter: 'zed', connection: 'zed.acp', queue: [] },
          },
        ],
        edges: [],
      }}
      onCanvas={(made) => {
        canvas = made;
      }}
    />,
  );
  expect(container.querySelector('.graph-card')?.getAttribute('title')).toBe(
    'Agent: Zed Agent · ACP',
  );
  const dock = within(screen.getByRole('navigation', { name: 'Canvas agents' }));
  const icon = dock.getByRole('button', { name: 'Worker, Zed Agent · ACP: Idle' });
  expect(icon.title).toContain('Zed Agent · ACP');
  await events.click(icon);
  const view = within(await screen.findByRole('dialog', { name: 'Worker' }));
  expect(view.getByRole('button', { name: 'Agent: Zed Agent · ACP' })).toBeTruthy();
  await events.click(view.getByRole('button', { name: 'Add to queue' }));
  await events.change(view.getByRole('combobox'), { target: { value: 'shell' } });
  const option = view.getByRole('option', { name: /shell.*Run a command/ });
  await events.click(option);
  await events.click(view.getByRole('option', { name: /This agent/ }));
  if (!canvas) throw new Error('No test canvas');
  expectOneOp(canvas.core, 'queue.add', {
    canvas: canvas.document.id,
    agent: 'worker',
    entry: { action: 'shell' },
  });
});

it.each([
  ['zed.free', false],
  ['zed.acp', true],
] as const)(
  'shows a canvas meter only when its actual %s connection spends that backend',
  async (connection, metered) => {
    await useCatalog(MADE_UP);
    await renderReady(
      <GraphEditor
        initialGraph={{
          nodes: [
            {
              id: 'worker',
              type: 'agent',
              position: { x: 0, y: 0 },
              data: { label: 'Worker', adapter: 'zed', connection },
            },
          ],
          edges: [],
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Zed usage:/ }) !== null).toBe(metered);
  },
);
