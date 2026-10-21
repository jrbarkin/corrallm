import { describe, expect, it } from 'vitest';

import type { CanvasNode, Position } from './canvas';
import {
  absolutePosition,
  autosize,
  bounds,
  CARD_SIZE,
  containerAt,
  EMPTY_FRAME,
  groupColors,
  nextGroupColor,
  PADDING,
  size,
  topInset,
} from './geometry';
import type { GeometryNode } from './geometry';

const agent = (id: string, x: number, y: number): CanvasNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id },
});

describe('model geometry', () => {
  it('fits a group of model nodes from CARD_SIZE, without a view', () => {
    const nodes: CanvasNode[] = [
      { id: 'G', type: 'frame', position: { x: 100, y: 200 }, data: { label: 'Team' } },
      { ...agent('a', 20, 52), parentId: 'G' },
    ];
    const fitted = autosize(nodes);
    const group = fitted[0];
    if (!group) throw new Error('no group');
    expect(size(group)).toEqual({
      width: 2 * PADDING + CARD_SIZE.width,
      height: topInset('frame') + CARD_SIZE.height + PADDING,
    });
    expect(fitted[1]).toBe(nodes[1]);
    expect(autosize(fitted)).toBe(fitted);
    expect(nodes[0]).not.toHaveProperty('width');
  });

  it('uses the same card size for an agent and its bounds', () => {
    const node = agent('a', 20, 30);
    expect(size(node)).toEqual(CARD_SIZE);
    expect(bounds([node])).toEqual({
      x1: 20,
      y1: 30,
      x2: 20 + CARD_SIZE.width,
      y2: 30 + CARD_SIZE.height,
    });
  });
});

function agentNode(
  id: string,
  x: number,
  y: number,
  extra: Partial<GeometryNode> = {},
): GeometryNode {
  return { id, type: 'agent', position: { x, y }, data: { label: id }, ...extra };
}

function frame(id: string, x: number, y: number, width: number, height: number): GeometryNode {
  return { id, type: 'frame', position: { x, y }, data: { label: id }, width, height };
}

function inside(parentId: string, node: GeometryNode): GeometryNode {
  return { ...node, parentId };
}

function frozen(nodes: GeometryNode[]): { nodes: GeometryNode[] } {
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(nodes);
  return { nodes };
}

function get(graph: { nodes: GeometryNode[] }, id: string): GeometryNode {
  const node = graph.nodes.find((node) => node.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function abs(graph: { nodes: GeometryNode[] }, id: string): Position {
  return absolutePosition(get(graph, id), new Map(graph.nodes.map((node) => [node.id, node])));
}

function absAll(graph: { nodes: GeometryNode[] }, ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, abs(graph, id)]));
}

function expectValid(graph: { nodes: GeometryNode[] }) {
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
  for (const [i, node] of graph.nodes.entries()) {
    if (node.parentId !== undefined) expect(index.get(node.parentId)).toBeLessThan(i);
    const children = graph.nodes.filter((child) => child.parentId === node.id);
    if (children.length === 0) continue;
    const right = Math.max(...children.map((child) => child.position.x + size(child).width));
    const bottom = Math.max(...children.map((child) => child.position.y + size(child).height));
    expect(Math.min(...children.map((child) => child.position.x))).toBe(PADDING);
    expect(Math.min(...children.map((child) => child.position.y))).toBe(topInset(node.type));
    expect(size(node)).toEqual({ width: right + PADDING, height: bottom + PADDING });
  }
}

function nested(): GeometryNode[] {
  return autosize([
    frame('H', 0, 0, 0, 0),
    inside('H', frame('G', 20, 52, 0, 0)),
    inside('G', frame('F', 20, 52, 0, 0)),
    inside('F', agentNode('c', 20, 52)),
    inside('F', agentNode('d', 20, 112)),
  ]);
}

function moved(nodes: GeometryNode[], id: string, position: Position): GeometryNode[] {
  return nodes.map((node) => (node.id === id ? { ...node, position } : node));
}

describe('autosize', () => {
  it('grows every container around a child dragged past their right and bottom', () => {
    const before = nested();
    expect(before.map((n) => [n.id, n.width, n.height])).toEqual([
      ['H', CARD_SIZE.width + 120, CARD_SIZE.height + 276],
      ['G', CARD_SIZE.width + 80, CARD_SIZE.height + 204],
      ['F', CARD_SIZE.width + 40, CARD_SIZE.height + 132],
      ['c', undefined, undefined],
      ['d', undefined, undefined],
    ]);
    const dragged = moved(before, 'd', { x: 300, y: 200 });
    const result = autosize(dragged);
    expect(result.map((n) => [n.id, n.position, n.width, n.height])).toEqual([
      ['H', { x: 0, y: 0 }, CARD_SIZE.width + 400, CARD_SIZE.height + 364],
      ['G', { x: 20, y: 52 }, CARD_SIZE.width + 360, CARD_SIZE.height + 292],
      ['F', { x: 20, y: 52 }, CARD_SIZE.width + 320, CARD_SIZE.height + 220],
      ['c', { x: 20, y: 52 }, undefined, undefined],
      ['d', { x: 300, y: 200 }, undefined, undefined],
    ]);
    expect(result[3]).toBe(dragged[3]);
    expectValid(frozen(result));
  });

  it('grows containers left and up for a child dragged past their top-left, moving nothing on screen', () => {
    const before = frozen(nested());
    const dragged = frozen(moved(before.nodes, 'c', { x: -60, y: -90 }));
    const result = frozen(autosize(dragged.nodes));
    expect(absAll(result, ['c', 'd'])).toEqual(absAll(dragged, ['c', 'd']));
    expect(get(result, 'c').position).toEqual({ x: 20, y: 52 });
    // Each container grew only left and up: its right and bottom edges stay where they were.
    for (const id of ['H', 'G', 'F']) {
      const was = get(before, id);
      const now = get(result, id);
      expect(abs(result, id).x + (now.width ?? 0), id).toBe(abs(before, id).x + (was.width ?? 0));
      expect(abs(result, id).y + (now.height ?? 0), id).toBe(abs(before, id).y + (was.height ?? 0));
    }
    expectValid(result);
  });

  it('shrinks every container around a child dragged back inward', () => {
    const grown = autosize(moved(nested(), 'd', { x: 300, y: 200 }));
    const result = autosize(moved(grown, 'd', { x: 20, y: 112 }));
    expect(result).toEqual(nested());
  });

  it('keeps pinned corners until the caller releases them', () => {
    const before = frozen(nested());
    const out = autosize(moved(before.nodes, 'c', { x: -60, y: 300 }), {
      pinned: new Set(['H', 'G', 'F']),
    });
    for (const id of ['H', 'G', 'F'])
      expect(get({ nodes: out }, id).position).toEqual(get(before, id).position);
    expect(get({ nodes: out }, 'F').height).toBe(300 + CARD_SIZE.height + PADDING);
    const dropped = frozen(autosize(out));
    expect(absAll(dropped, ['c', 'd'])).toEqual(absAll({ nodes: out }, ['c', 'd']));
    expectValid(dropped);
  });

  it('shrinks a childless frame to EMPTY_FRAME and turns a childless parent node into its card', () => {
    const result = autosize([
      frame('F', 100, 100, 400, 300),
      { ...agentNode('p', 0, 0), width: 300, height: 200 },
    ]);
    expect(result[0]).toMatchObject({ position: { x: 100, y: 100 }, ...EMPTY_FRAME });
    expect(result[1]).toEqual(agentNode('p', (300 - CARD_SIZE.width) / 2, 0));
  });

  it('returns the same array when every container fits', () => {
    const nodes = frozen([...nested(), agentNode('z', -500, -500)]).nodes;
    expect(autosize(nodes)).toBe(nodes);
    expect(autosize([])).toEqual([]);
  });
});

describe('containerAt', () => {
  const nodes = [
    frame('F', 0, 0, 500, 400),
    inside('F', frame('G', 20, 52, 200, 200)),
    frame('H', 400, 300, 300, 300),
    agentNode('p', 1000, 0, { width: 200, height: 200 }),
    inside('p', agentNode('c', 20, 52)),
    agentNode('leaf', 1000, 500),
  ];

  it('finds the innermost container under the point', () => {
    expect(containerAt(nodes, { x: 50, y: 100 })?.id).toBe('G');
    expect(containerAt(nodes, { x: 300, y: 100 })?.id).toBe('F');
    expect(containerAt(nodes, { x: 450, y: 350 })?.id).toBe('H');
    expect(containerAt(nodes, { x: 1100, y: 150 })?.id).toBe('p');
  });

  it('ignores items without children and empty canvas', () => {
    expect(containerAt(nodes, { x: 1050, y: 510 })).toBeUndefined();
    expect(containerAt(nodes, { x: 900, y: 900 })).toBeUndefined();
  });
});

describe('group colours', () => {
  it("colours a group's nodes with its colour, and nested groups with their own", () => {
    const nodes = [
      { ...frame('F', 0, 0, 400, 400), data: { label: 'F', color: 2 } },
      inside('F', agentNode('a', 20, 52)),
      inside('F', { ...frame('G', 20, 120, 200, 200), data: { label: 'G', color: 5 } }),
      inside('G', agentNode('b', 20, 52)),
      agentNode('c', 600, 0),
    ];
    expect(Object.fromEntries(groupColors(nodes))).toEqual({ F: 2, a: 2, G: 5, b: 5 });
  });

  it('uses the least used group colour, breaking ties in palette order', () => {
    const groups = [0, 1, 1, 2].map((color, i) => ({
      ...frame(String(i), 0, 0, 200, 200),
      data: { label: String(i), color },
    }));
    expect(nextGroupColor(groups)).toBe(3);
    expect(nextGroupColor([])).toBe(0);
  });

  it('ignores a leaf colour but counts an agent that holds a group', () => {
    const nodes = [
      { ...agentNode('leaf', 0, 0), data: { label: 'Leaf', color: 0 } },
      { ...agentNode('parent', 0, 0), data: { label: 'Parent', color: 1 } },
      inside('parent', agentNode('child', 20, 52)),
    ];
    expect(nextGroupColor(nodes)).toBe(0);
    expect(Object.fromEntries(groupColors(nodes))).toEqual({ parent: 1, child: 1 });
  });
});
