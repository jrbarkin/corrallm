import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { handoff } from '../../shared/model/test-b19';
import { fakeCanvas } from '../test-canvas';
import { events, renderReady } from '../test-render';
import { GraphEditor } from './GraphEditor';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
const closing: (() => void)[] = [];
afterEach(() => {
  cleanup();
  closing.splice(0).forEach((close) => {
    close();
  });
});

/*
 * B19 X2 through the whole editor: one queue hand-off, read from the messages topic, is a row in
 * its recipient's queue in All queues and in the agent's own view, from its sender, with no control
 * of its own, and reading it changes no document and sends no operation.
 */

async function setup() {
  const doc: CanvasDocument = {
    id: newCanvasId(),
    arrange: false,
    nodes: [
      {
        id: 'lead',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'Lead', queue: [{ id: 'hand', message: 'Review this', target: 'worker' }] },
      },
      {
        id: 'worker',
        type: 'agent',
        position: { x: 400, y: 0 },
        data: {
          label: 'Worker',
          queue: [
            { id: 'one', action: 'Read' },
            { id: 'two', action: 'Bash' },
          ],
        },
      },
    ],
    links: [],
  };
  const canvas = fakeCanvas(doc);
  closing.push(() => {
    canvas.core.dispose();
  });
  const view = await renderReady(
    <GraphEditor canvas={doc.id} client={canvas.core.api} mirror={canvas.core.topics} />,
  );
  return { ...view, canvas };
}

it('shows a pending hand-off in All queues and the recipient’s view, read-only, after the task it is on', async () => {
  const { canvas } = await setup();
  const offered = handoff('lead', 'worker', { item: 'hand', body: 'Check the parser' });
  const before = JSON.stringify(canvas.document.nodes);
  act(() => {
    canvas.run({
      running: true,
      agents: {
        lead: { current: 'hand', status: 'waiting', outcomes: {} },
        worker: { current: 'one', status: 'running', outcomes: {} },
      },
    });
    canvas.messages([offered]);
  });
  canvas.core.operations.length = 0;

  await events.click(screen.getByRole('button', { name: 'Show all queues' }));
  const all = within(screen.getByRole('dialog', { name: 'All queues' }));
  const rows = all.getAllByText('From Lead');
  expect(rows).toHaveLength(1);
  const row = rows[0]?.closest<HTMLElement>('.graph-queue-submission');
  expect(row?.textContent).toContain('Check the parser');
  expect(row?.querySelector('button, textarea, input')).toBeNull();
  // After Worker's current task, before the next.
  const order = [...all.getAllByText(/^(Read|Bash|Check the parser)$/)].map(
    (node) => node.textContent,
  );
  expect(order.indexOf('Check the parser')).toBeGreaterThan(order.indexOf('Read'));
  expect(order.indexOf('Check the parser')).toBeLessThan(order.indexOf('Bash'));

  await events.click(screen.getByRole('button', { name: 'Show all queues' }));
  await events.click(screen.getByRole('button', { name: /^Worker,/ }));
  const own = within(screen.getByRole('complementary', { name: 'Questions and queue' }));
  const received = own.getByText('From Lead').closest('.graph-queue-submission');
  expect(received?.textContent).toContain('Check the parser');
  expect(received?.querySelector('button, textarea, input')).toBeNull();
  expect(canvas.core.operations).toEqual([]);
  expect(JSON.stringify(canvas.document.nodes)).toBe(before);
});
