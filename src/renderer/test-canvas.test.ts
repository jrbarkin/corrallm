import { afterEach, expect, it } from 'vitest';

import { newCanvasId } from '../shared/canvas';
import type { CanvasDocument } from '../shared/model/canvas';
import { fakeCanvas } from './test-canvas';
import type { FakeCanvas } from './test-canvas';

const cores: FakeCanvas[] = [];
afterEach(() => {
  for (const canvas of cores.splice(0)) canvas.core.dispose();
});

it.each([
  [
    'empty delete',
    (canvas: FakeCanvas) =>
      canvas.core.api.canvasDelete({ canvas: canvas.document.id, nodes: [], links: [] }),
  ],
  [
    'rename',
    (canvas: FakeCanvas) =>
      canvas.core.api.canvasRename({ canvas: canvas.document.id, node: 'a', label: 'Renamed' }),
  ],
  [
    'move',
    (canvas: FakeCanvas) =>
      canvas.core.api.canvasMove({
        canvas: canvas.document.id,
        moves: [{ node: 'a', position: { x: 30, y: 40 } }],
      }),
  ],
  [
    'queue update',
    (canvas: FakeCanvas) =>
      canvas.core.api.queueUpdate({
        canvas: canvas.document.id,
        agent: 'a',
        item: 'work',
        change: { kind: 'message', message: 'New work' },
      }),
  ],
  [
    'role',
    (canvas: FakeCanvas) =>
      canvas.core.api.agentSetRole({ canvas: canvas.document.id, agent: 'a', role: 'Review' }),
  ],
  [
    'unchanged Arrange',
    (canvas: FakeCanvas) =>
      canvas.core.api.canvasSetArrange({ canvas: canvas.document.id, on: true }),
  ],
] as const)('keeps the core’s positions after %s with Arrange already on', async (name, edit) => {
  const document: CanvasDocument = {
    id: newCanvasId(),
    arrange: true,
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { label: 'A', queue: [{ id: 'work', message: 'Work' }] },
      },
      { id: 'b', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'B' } },
    ],
    links: [{ source: 'a', target: 'b' }],
  };
  const canvas = fakeCanvas(document);
  cores.push(canvas);
  await edit(canvas);
  expect(canvas.document.nodes.map(({ id, position }) => ({ id, position }))).toEqual([
    { id: 'a', position: name === 'move' ? { x: 30, y: 40 } : { x: 0, y: 0 } },
    { id: 'b', position: { x: 600, y: 0 } },
  ]);
});
