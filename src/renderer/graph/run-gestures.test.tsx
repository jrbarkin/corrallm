import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
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
async function setup() {
  const doc: CanvasDocument = {
    id: newCanvasId(),
    arrange: false,
    nodes: [
      { id: 'g', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team' } },
      {
        id: 'a',
        type: 'agent',
        parentId: 'g',
        position: { x: 0, y: 0 },
        data: { label: 'Writer', queue: [{ id: 'ok', approve: 'the work' }] },
      },
    ],
    links: [],
  };
  const canvas = fakeCanvas(doc);
  closing.push(() => {
    canvas.core.dispose();
  });
  const view = await renderReady(
    <GraphEditor
      canvas={doc.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      sessionQueries={{
        ...canvas.queries,
        manual: canvas.manual,
        presentation: canvas.presentation,
      }}
    />,
  );
  return { ...view, canvas };
}
it('Run, Stop, Resume and Run again are each one core operation', async () => {
  const { canvas } = await setup();
  const args = { canvas: canvas.document.id };
  for (const [label, op] of [
    ['Run', 'run.start'],
    ['Stop', 'run.stop'],
    ['Resume', 'run.resume'],
    ['Run again', 'run.start'],
  ] as const) {
    canvas.core.operations.length = 0;
    await events.click(screen.getByRole('button', { name: label }));
    expectOneOp(canvas.core, op, args);
  }
});
it.each(['a', 'g'] as const)(
  'the %s menu pauses, releases and kills with one operation per choice',
  async (id) => {
    const { canvas, container } = await setup();
    const card = container.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!card) throw new Error('Missing node');
    const target = id === 'a' ? { agent: id } : { group: id };
    for (const [label, op] of [
      ['Pause', 'run.pause'],
      ['Resume', 'run.unpause'],
      ['Kill', 'run.kill'],
    ] as const) {
      canvas.core.operations.length = 0;
      await events.contextMenu(card);
      await events.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }));
      expectOneOp(canvas.core, op, { canvas: canvas.document.id, target });
    }
    const agent = canvas.document.nodes[1];
    expect(agent?.type === 'agent' && agent.data.queue).toEqual([
      { id: 'ok', approve: 'the work' },
    ]);
  },
);
it('answering the current run hold is one typed reply', async () => {
  const { canvas } = await setup();
  await events.click(screen.getByRole('button', { name: 'Run' }));
  const need = canvas.core
    .state(`needs:${canvas.document.id}`)
    ?.state.items.find((item) => item.id.startsWith('hold/'));
  if (!need) throw new Error('Missing hold');
  canvas.core.operations.length = 0;
  await events.click(screen.getByRole('button', { name: 'Needs you' }));
  await events.click(screen.getByRole('button', { name: 'Approve' }));
  expectOneOp(canvas.core, 'reply', {
    canvas: canvas.document.id,
    to: need.id,
    answer: { choice: 'approve' },
  });
});
