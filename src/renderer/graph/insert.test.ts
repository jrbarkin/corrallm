import { expect, it } from 'vitest';
import type { Graph } from './graph';
import { insertGraph } from './insert';

it('applies the model selection hint and draws imported links between their dots', () => {
  const before: Graph = {
    nodes: [
      { id: 'a', type: 'agent', selected: true, position: { x: 0, y: 0 }, data: { label: 'A' } },
    ],
    edges: [],
  };
  const part: Graph = {
    nodes: [
      { id: 'x', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'X' } },
      { id: 'y', type: 'agent', position: { x: 0, y: 200 }, data: { label: 'Y' } },
    ],
    edges: [{ id: 'xy', source: 'x', target: 'y', sourceHandle: 'bottom', targetHandle: 'top' }],
  };
  let n = 0;
  const next = insertGraph(before, part, {
    name: 'New',
    group: 'g',
    newId: () => `new-${String(++n)}`,
  });
  expect(next.nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['g']);
  expect(next.edges).toEqual([
    {
      id: 'new-1->new-2',
      source: 'new-1',
      target: 'new-2',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    },
  ]);
  expect(before.nodes[0]?.selected).toBe(true);
});
