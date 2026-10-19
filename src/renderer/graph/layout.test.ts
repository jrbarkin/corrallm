import { expect, it } from 'vitest';
import type { Graph } from './graph';
import { arrange } from './layout';

it('keeps view state and measured box sizes through model layout', () => {
  const graph: Graph = {
    nodes: [
      {
        id: 'a',
        type: 'agent',
        selected: true,
        position: { x: 0, y: 0 },
        data: { label: 'A' },
        measured: { width: 100, height: 40 },
      },
      {
        id: 'b',
        type: 'agent',
        position: { x: 400, y: 400 },
        data: { label: 'B' },
        measured: { width: 100, height: 40 },
      },
    ],
    edges: [{ id: 'edge', source: 'a', target: 'b', selected: true }],
  };
  const next = arrange(graph);
  expect(next.nodes[0]?.selected).toBe(true);
  expect(next.nodes[0]?.measured).toBe(graph.nodes[0]?.measured);
  expect(next.nodes[1]?.position).toEqual({ x: 0, y: 100 });
  expect(next.edges).toBe(graph.edges);
  expect(arrange(next)).toBe(next);
});
