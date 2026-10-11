import type { Edge, XYPosition } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { absolutePosition, autosize, size } from './graph';
import type { Graph, GraphNode } from './graph';
import { arrange } from './layout';

const agentNode = (id: string, x: number, y: number, parentId?: string): GraphNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id },
  measured: { width: 100, height: 40 },
  ...(parentId === undefined ? {} : { parentId }),
});

const frame = (id: string, x: number, y: number): GraphNode => ({
  id,
  type: 'frame',
  position: { x, y },
  data: { label: id },
});

const edge = (source: string, target: string): Edge => ({
  id: `${source}->${target}`,
  source,
  target,
});

function boxOf(graph: Graph, id: string) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  const { x, y }: XYPosition = absolutePosition(node, new Map(graph.nodes.map((n) => [n.id, n])));
  return { x, y, ...size(node) };
}

const centerX = (b: { x: number; width: number }) => b.x + b.width / 2;

function expectApart(a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) {
  const overlap =
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap).toBe(false);
}

describe('arrange', () => {
  it('stacks nodes top to bottom along their edges', () => {
    const g = arrange({
      nodes: [agentNode('c', 0, 0), agentNode('a', 500, 300), agentNode('b', 90, 700)],
      edges: [edge('a', 'b'), edge('b', 'c')],
    });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => boxOf(g, id));
    if (!a || !b || !c) throw new Error('missing');
    expect(a.y + a.height).toBeLessThan(b.y);
    expect(b.y + b.height).toBeLessThan(c.y);
    expect(centerX(a)).toBe(centerX(b));
    expect(centerX(b)).toBe(centerX(c));
  });

  it('places the targets of one node side by side, without overlaps', () => {
    const g = arrange({
      nodes: [
        agentNode('a', 0, 0),
        agentNode('b', 0, 0),
        agentNode('c', 0, 0),
        agentNode('d', 0, 0),
      ],
      edges: [edge('a', 'b'), edge('a', 'c')],
    });
    const [b, c] = ['b', 'c'].map((id) => boxOf(g, id));
    if (!b || !c) throw new Error('missing');
    expect(b.y).toBe(c.y);
    const ids = ['a', 'b', 'c', 'd'];
    for (const [i, x] of ids.entries()) {
      for (const y of ids.slice(i + 1)) expectApart(boxOf(g, x), boxOf(g, y));
    }
  });

  it("lays out a group's nodes inside it, and the group among its siblings", () => {
    const g = arrange({
      nodes: autosize([
        frame('F', 0, 0),
        agentNode('x', 300, 0, 'F'),
        agentNode('y', 20, 400, 'F'),
        agentNode('z', 900, 900),
      ]),
      // z feeds the group: the group goes below z. Inside, x -> y.
      edges: [edge('z', 'x'), edge('x', 'y')],
    });
    const [F, x, y, z] = ['F', 'x', 'y', 'z'].map((id) => boxOf(g, id));
    if (!F || !x || !y || !z) throw new Error('missing');
    expect(x.y + x.height).toBeLessThan(y.y);
    expect(z.y + z.height).toBeLessThan(F.y);
    // F still fits what it holds.
    expect(g.nodes).toEqual(autosize(g.nodes));
    expectApart(F, z);
  });

  it('follows the work queues give other agents, as it follows edges', () => {
    const a = agentNode('a', 0, 300);
    const g = arrange({
      nodes: [
        { ...a, data: { label: 'a', queue: [{ id: 's', action: 'Read', target: 'b' }] } },
        agentNode('b', 0, 0),
      ],
      edges: [],
    });
    const [boxA, boxB] = ['a', 'b'].map((id) => boxOf(g, id));
    if (!boxA || !boxB) throw new Error('missing');
    expect(boxA.y + boxA.height).toBeLessThan(boxB.y);
  });

  it('keeps the graph where it was, and leaves an arranged graph alone', () => {
    const before: Graph = {
      nodes: [agentNode('a', 200, 150), agentNode('b', 600, 900)],
      edges: [edge('a', 'b')],
    };
    const once = arrange(before);
    const left = Math.min(...once.nodes.map((n) => n.position.x));
    const top = Math.min(...once.nodes.map((n) => n.position.y));
    expect({ left, top }).toEqual({ left: 200, top: 150 });
    expect(arrange(once)).toBe(once);
  });
});
