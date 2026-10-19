import { expect, it } from 'vitest';
import type { Graph } from './graph';
import { withConnections } from './templates';

it('applies the renderer’s partial connection choices without resetting other agents', () => {
  const graph: Graph = {
    nodes: [
      { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } },
      {
        id: 'b',
        type: 'agent',
        position: { x: 400, y: 0 },
        data: { label: 'B', adapter: 'codex', connection: 'codex.app-server' },
      },
    ],
    edges: [],
  };
  const changed = withConnections(graph, { a: 'claude-code.sdk' });
  expect(changed.nodes[0]?.data.connection).toBe('claude-code.sdk');
  expect(changed.nodes[1]).toBe(graph.nodes[1]);
  expect(withConnections(graph, {})).toBe(graph);
});
