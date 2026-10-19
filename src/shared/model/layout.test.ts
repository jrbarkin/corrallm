import { describe, expect, it } from 'vitest';

import { absolutePosition, autosize, size, CARD_SIZE } from './geometry';
import type { CanvasId } from '../canvas';
import type { AgentNode, CanvasDocument, CanvasNode, Link, Position } from './canvas';
import { arrange as arrangeDocument } from './layout';
const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
type Graph = Pick<CanvasDocument, 'nodes' | 'links'>;
const arrange = (doc: Graph): CanvasDocument =>
  arrangeDocument('id' in doc ? (doc as CanvasDocument) : { id: ID, arrange: true, ...doc });

const agentNode = (id: string, x: number, y: number, parentId?: string): AgentNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id },
  ...(parentId === undefined ? {} : { parentId }),
});

const frame = (id: string, x: number, y: number): CanvasNode => ({
  id,
  type: 'frame',
  position: { x, y },
  data: { label: id },
});

const edge = (source: string, target: string): Link => ({
  source,
  target,
});

function boxOf(graph: Graph, id: string) {
  const fitted = autosize(graph.nodes);
  const node = fitted.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  const { x, y }: Position = absolutePosition(node, new Map(fitted.map((n) => [n.id, n])));
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
      links: [edge('a', 'b'), edge('b', 'c')],
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
      links: [edge('a', 'b'), edge('a', 'c')],
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
      nodes: [
        frame('F', 0, 0),
        agentNode('x', 300, 0, 'F'),
        agentNode('y', 20, 400, 'F'),
        agentNode('z', 900, 900),
      ],
      // z feeds the group: the group goes below z. Inside, x -> y.
      links: [edge('z', 'x'), edge('x', 'y')],
    });
    const [F, x, y, z] = ['F', 'x', 'y', 'z'].map((id) => boxOf(g, id));
    if (!F || !x || !y || !z) throw new Error('missing');
    expect(x.y + x.height).toBeLessThan(y.y);
    expect(z.y + z.height).toBeLessThan(F.y);
    // F still fits what it holds.
    expect(autosize(g.nodes).map((node) => node.position)).toEqual(
      g.nodes.map((node) => node.position),
    );
    expectApart(F, z);
  });

  it('follows the work queues give other agents, as it follows edges', () => {
    const a = agentNode('a', 0, 300);
    const g = arrange({
      nodes: [
        { ...a, data: { label: 'a', queue: [{ id: 's', action: 'Read', target: 'b' }] } },
        agentNode('b', 0, 0),
      ],
      links: [],
    });
    const [boxA, boxB] = ['a', 'b'].map((id) => boxOf(g, id));
    if (!boxA || !boxB) throw new Error('missing');
    expect(boxA.y + boxA.height).toBeLessThan(boxB.y);
  });

  it('keeps the graph where it was, and leaves an arranged graph alone', () => {
    const before: Graph = {
      nodes: [agentNode('a', 200, 150), agentNode('b', 600, 900)],
      links: [edge('a', 'b')],
    };
    const once = arrange(before);
    const left = Math.min(...once.nodes.map((n) => n.position.x));
    const top = Math.min(...once.nodes.map((n) => n.position.y));
    expect({ left, top }).toEqual({ left: 200, top: 150 });
    expect(arrange(once)).toBe(once);
  });
});

it('sizes cards from CARD_SIZE and preserves node data, links and an already arranged document', () => {
  const before: CanvasDocument = {
    id: ID,
    arrange: true,
    nodes: [agentNode('a', 0, 0), agentNode('b', 400, 400)],
    links: [edge('a', 'b')],
  };
  const after = arrangeDocument(before);
  expect(boxOf(after, 'a')).toMatchObject(CARD_SIZE);
  expect(after.nodes[0]?.data).toBe(before.nodes[0]?.data);
  expect(after.links).toBe(before.links);
  expect(arrangeDocument(after)).toBe(after);
  for (const node of after.nodes) expect(node).not.toHaveProperty('width');
});

it('keeps nested arranged documents identical and never retains computed boxes', () => {
  const before: CanvasDocument = {
    id: ID,
    arrange: true,
    nodes: [
      frame('outer', 0, 0),
      { ...agentNode('parent', 20, 52, 'outer'), data: { label: 'Parent' } },
      agentNode('x', 20, 69, 'parent'),
      agentNode('y', 400, 400, 'parent'),
      agentNode('z', 900, 0),
    ],
    links: [edge('x', 'y'), edge('z', 'parent')],
  };
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(before);
  const once = arrangeDocument(before);
  expect(arrangeDocument(once)).toBe(once);
  expect(once.links).toBe(before.links);
  once.nodes.forEach((node, i) => {
    expect(node.data).toBe(before.nodes[i]?.data);
    expect(node).not.toHaveProperty('width');
    expect(node).not.toHaveProperty('height');
  });
});
