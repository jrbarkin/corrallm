import { MarkerType } from '@xyflow/react';
import type { Edge, XYPosition } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import {
  absolutePosition,
  addNode,
  addParent,
  addToQueue,
  autosize,
  canConnect,
  canUngroup,
  connect,
  containerAt,
  deleteEdge,
  deleteSelection,
  EMPTY_FRAME,
  groupMembers,
  groupSelection,
  HEADER,
  ITEM_SIZE,
  nextLabel,
  PADDING,
  removeFromQueue,
  renameNode,
  selectOnly,
  size,
  ungroupSelection,
} from './graph';
import type { Graph, GraphNode } from './graph';
import { QueueItemKind } from './queue';

/** An item measured at 100×40. */
function item(id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'item',
    position: { x, y },
    data: { label: id },
    measured: { width: 100, height: 40 },
    ...extra,
  };
}

function frame(id: string, x: number, y: number, width: number, height: number): GraphNode {
  return {
    id,
    type: 'frame',
    position: { x, y },
    data: { label: id },
    width,
    height,
    measured: { width, height },
  };
}

function inside(parentId: string, node: GraphNode): GraphNode {
  return { ...node, parentId };
}

function selected(node: GraphNode): GraphNode {
  return { ...node, selected: true };
}

function edge(source: string, target: string, extra: Partial<Edge> = {}): Edge {
  return { id: `${source}->${target}`, source, target, ...extra };
}

/** Freezes the graph deeply, so any mutation by an operation throws. */
function graphOf(nodes: GraphNode[], edges: Edge[] = []): Graph {
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  const graph = { nodes, edges };
  freeze(graph);
  return graph;
}

function get(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

function abs(graph: Graph, id: string): XYPosition {
  return absolutePosition(get(graph, id), new Map(graph.nodes.map((n) => [n.id, n])));
}

function absAll(graph: Graph, ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, abs(graph, id)]));
}

function selectedIds(graph: Graph) {
  return graph.nodes.filter((n) => n.selected).map((n) => n.id);
}

/**
 * Invariants every operation keeps: parents come before their children, React Flow's
 * `expandParent` is never used, and every container exactly fits its children: PADDING inside its
 * left, right and bottom edges and PADDING below the header zone at the top of its box.
 */
function expectValid(graph: Graph) {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  for (const [i, node] of graph.nodes.entries()) {
    expect(node.expandParent, node.id).toBeUndefined();
    if (node.parentId !== undefined) {
      expect(index.get(node.parentId), `${node.parentId} before ${node.id}`).toBeLessThan(i);
    }
    const children = graph.nodes.filter((n) => n.parentId === node.id);
    if (children.length === 0) continue;
    // A parent node's card straddles the box's top border, above the same header zone a frame has.
    const top = (node.type === 'frame' ? 0 : ITEM_SIZE.height / 2) + HEADER + PADDING;
    const right = Math.max(...children.map((c) => c.position.x + size(c).width));
    const bottom = Math.max(...children.map((c) => c.position.y + size(c).height));
    expect(Math.min(...children.map((c) => c.position.x)), node.id).toBe(PADDING);
    expect(Math.min(...children.map((c) => c.position.y)), node.id).toBe(top);
    expect(node.width, node.id).toBe(right + PADDING);
    expect(node.height, node.id).toBe(bottom + PADDING);
    expect(node.measured, node.id).toEqual({ width: node.width, height: node.height });
  }
}

/** Frame H holding frame G holding frame F holding items c and d, all sized to fit. */
function nested(): GraphNode[] {
  return autosize([
    frame('H', 0, 0, 0, 0),
    inside('H', frame('G', 20, 52, 0, 0)),
    inside('G', frame('F', 20, 52, 0, 0)),
    inside('F', item('c', 20, 52)),
    inside('F', item('d', 20, 112)),
  ]);
}

/** `nodes` with node `id` moved to `position`, as a drag would leave it. */
function moved(nodes: GraphNode[], id: string, position: XYPosition): GraphNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, position } : n));
}

describe('nextLabel', () => {
  it('numbers past the largest existing label with the prefix', () => {
    expect(nextLabel([], 'Node')).toBe('Node 1');
    const nodes = ['Node 2', 'Node 7', 'Node 9a', 'Group 12', 'Alpha'].map((label, i) =>
      item(String(i), 0, 0, { data: { label } }),
    );
    expect(nextLabel(nodes, 'Node')).toBe('Node 8');
    expect(nextLabel(nodes, 'Group')).toBe('Group 13');
  });
});

describe('addNode', () => {
  it('adds a selected item centred on the point and deselects everything else', () => {
    const g = graphOf([selected(item('a', 0, 0))], [edge('a', 'a', { selected: true })]);
    const result = addNode(g, 'n', { x: 200, y: 100 });
    expect(get(result, 'n')).toEqual({
      id: 'n',
      type: 'item',
      position: { x: 125, y: 83 },
      data: { label: 'Node 1' },
      selected: true,
    });
    expect(selectedIds(result)).toEqual(['n']);
    expect(result.edges[0]?.selected).toBe(false);
  });

  it('nudges a node that would land on the corner of another', () => {
    let g = graphOf([]);
    for (const id of ['a', 'b', 'c']) g = addNode(g, id, { x: 200, y: 100 });
    expect(g.nodes.map((n) => n.position)).toEqual([
      { x: 125, y: 83 },
      { x: 149, y: 107 },
      { x: 173, y: 131 },
    ]);
  });

  it('adds into the innermost container under the point, which grows to fit it', () => {
    // F at (100, 100) holds G at (120, 152), which holds x at (140, 204).
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', frame('G', 20, 52, 0, 0)),
        inside('G', item('x', 20, 52)),
      ]),
    );
    const result = addNode(g, 'n', { x: 250, y: 250 });
    expect(get(result, 'n').parentId).toBe('G');
    expect(abs(result, 'n')).toEqual({ x: 175, y: 233 });
    expect(abs(result, 'x')).toEqual(abs(g, 'x'));
    expect(abs(result, 'F')).toEqual(abs(g, 'F'));
    expectValid(result);
  });

  it('moves a container left and up for a node added past its padding, moving nothing else', () => {
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', frame('G', 20, 52, 0, 0)),
        inside('G', item('x', 20, 52)),
      ]),
    );
    const result = addNode(g, 'n', { x: 130, y: 220 }); // just inside G's left edge
    expect(get(result, 'n').parentId).toBe('G');
    expect(abs(result, 'n')).toEqual({ x: 55, y: 203 });
    expect(abs(result, 'x')).toEqual(abs(g, 'x'));
    expect(abs(result, 'F').x).toBeLessThan(100);
    expectValid(result);
  });
});

describe('renameNode', () => {
  it('renames items and frames, accepting an empty label', () => {
    const g = graphOf([item('a', 0, 0), frame('F', 0, 0, 100, 100)]);
    expect(get(renameNode(g, 'a', 'Alpha'), 'a').data.label).toBe('Alpha');
    expect(get(renameNode(g, 'F', ''), 'F').data.label).toBe('');
  });

  it('returns the same graph when nothing changes', () => {
    const g = graphOf([item('a', 0, 0)]);
    expect(renameNode(g, 'a', 'a')).toBe(g);
    expect(renameNode(g, 'missing', 'x')).toBe(g);
  });
});

describe('addToQueue and removeFromQueue', () => {
  const g = graphOf([item('a', 0, 0), item('b', 0, 100)]);
  const first = { id: 'q1', kind: QueueItemKind.PlaceholderA };
  const second = { id: 'q2', kind: QueueItemKind.PlaceholderC };

  it("appends items to a node's queue, in order", () => {
    const result = addToQueue(addToQueue(g, 'a', first), 'a', second);
    expect(get(result, 'a').data).toEqual({ label: 'a', queue: [first, second] });
    expect(get(result, 'b')).toBe(get(g, 'b'));
    expect(addToQueue(g, 'missing', first)).toBe(g);
  });

  it("removes one item from a node's queue", () => {
    const queued = addToQueue(addToQueue(g, 'a', first), 'a', second);
    expect(get(removeFromQueue(queued, 'a', 'q1'), 'a').data.queue).toEqual([second]);
    expect(removeFromQueue(queued, 'a', 'missing')).toBe(queued);
    expect(removeFromQueue(queued, 'b', 'q1')).toBe(queued);
  });
});

describe('selectOnly', () => {
  it('selects only that node, deselecting other nodes and every edge', () => {
    const g = graphOf(
      [selected(item('a', 0, 0)), selected(item('b', 0, 100)), item('c', 0, 200)],
      [edge('a', 'b', { selected: true })],
    );
    const result = selectOnly(g, 'b');
    expect(selectedIds(result)).toEqual(['b']);
    expect(result.edges[0]?.selected).toBe(false);
    expect(get(result, 'b')).toBe(get(g, 'b'));
    expect(get(result, 'c')).toBe(get(g, 'c'));
  });

  it('returns the same graph when that node is already the only selected element', () => {
    const g = graphOf([item('a', 0, 0), selected(item('b', 0, 100))], [edge('a', 'b')]);
    expect(selectOnly(g, 'b')).toBe(g);
  });
});

describe('connect', () => {
  const g = graphOf([
    item('a', 0, 0),
    item('b', 0, 100),
    frame('F', 300, 0, 200, 200),
    inside('F', item('c', 20, 52)),
  ]);

  it('adds a directed edge with an arrowhead at the target', () => {
    expect(connect(g, { source: 'a', target: 'b' }).edges).toEqual([
      { id: 'a->b', source: 'a', target: 'b', markerEnd: { type: MarkerType.ArrowClosed } },
    ]);
  });

  it('rejects self-loops, duplicates, frames and unknown nodes', () => {
    const ab = connect(g, { source: 'a', target: 'b' });
    for (const [source, target] of [
      ['a', 'a'],
      ['a', 'b'],
      ['a', 'F'],
      ['F', 'a'],
      ['a', 'missing'],
    ] as const) {
      expect(canConnect(ab, { source, target }), `${source}->${target}`).toBe(false);
      expect(connect(ab, { source, target })).toBe(ab);
    }
  });

  it('allows the reverse direction and edges into a container', () => {
    const ab = connect(g, { source: 'a', target: 'b' });
    expect(connect(ab, { source: 'b', target: 'a' }).edges).toHaveLength(2);
    expect(canConnect(ab, { source: 'a', target: 'c' })).toBe(true);
  });

  it('keeps the dots an edge was drawn between, so b -> a can run back along a -> b', () => {
    const ab = connect(g, {
      source: 'a',
      target: 'b',
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
    const ba = connect(ab, {
      source: 'b',
      target: 'a',
      sourceHandle: 'top',
      targetHandle: 'bottom',
    });
    expect(ba.edges).toEqual([
      expect.objectContaining({ id: 'a->b', sourceHandle: 'bottom', targetHandle: 'top' }),
      expect.objectContaining({ id: 'b->a', sourceHandle: 'top', targetHandle: 'bottom' }),
    ]);
  });
});

describe('deleteEdge', () => {
  it('deletes only that edge', () => {
    const g = graphOf([item('a', 0, 0), item('b', 0, 100)], [edge('a', 'b'), edge('b', 'a')]);
    expect(deleteEdge(g, 'a->b').edges).toEqual([edge('b', 'a')]);
    expect(deleteEdge(g, 'missing')).toBe(g);
  });
});

describe('deleteSelection', () => {
  it('deletes the selected nodes and edges, and the edges of deleted nodes', () => {
    const g = graphOf(
      [selected(item('a', 0, 0)), item('b', 0, 100), item('c', 0, 200)],
      [edge('a', 'b'), edge('c', 'a'), edge('b', 'c', { selected: true }), edge('c', 'b')],
    );
    const result = deleteSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(result.edges.map((e) => e.id)).toEqual(['c->b']);
  });

  it('returns the same graph when nothing is selected', () => {
    const g = graphOf([item('a', 0, 0)], [edge('a', 'a')]);
    expect(deleteSelection(g)).toBe(g);
  });

  it('keeps the children of a deleted container, in place, in the nearest surviving ancestor', () => {
    const g = graphOf([
      frame('P', 10, 10, 300, 300),
      selected(inside('P', frame('F', 20, 40, 200, 200))),
      inside('F', item('a', 5, 6)),
      frame('T', 500, 0, 300, 300),
      selected(inside('T', frame('U', 20, 52, 200, 200))),
      inside('U', selected(frame('V', 20, 52, 150, 120))),
      inside('V', item('b', 20, 52)),
    ]);
    const result = deleteSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['P', 'a', 'T', 'b']);
    expect(get(result, 'a').parentId).toBe('P');
    expect(get(result, 'b').parentId).toBe('T');
    expect(absAll(result, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(result);
  });

  it('shrinks a container to fit what is left, and an emptied frame to its smallest size', () => {
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', item('a', 20, 52)),
        selected(inside('F', item('b', 300, 200))),
        frame('E', 600, 100, 0, 0),
        selected(inside('E', item('e', 20, 52))),
      ]),
    );
    const result = deleteSelection(g);
    expect(get(result, 'F')).toMatchObject({
      position: { x: 100, y: 100 },
      width: 140,
      height: 112,
    });
    expect(get(result, 'E')).toMatchObject({ position: { x: 600, y: 100 }, ...EMPTY_FRAME });
    expectValid(result);
  });

  it('moves the children of a deleted top-level frame to the top level', () => {
    const g = graphOf([selected(frame('F', 100, 100, 300, 200)), inside('F', item('a', 20, 52))]);
    expect(deleteSelection(g).nodes).toEqual([item('a', 120, 152)]);
  });

  it('turns a parent node whose last child is deleted back into a plain node, keeping its edges', () => {
    const parent: GraphNode = { ...item('p', 0, 0), width: 300, height: 200 };
    const g = graphOf(
      [parent, item('b', 400, 0), selected(inside('p', item('a', 20, 54)))],
      [edge('p', 'b')],
    );
    const result = deleteSelection(g);
    // Where its card was: centred on the box's top border.
    expect(get(result, 'p')).toEqual(item('p', 75, 0));
    expect(result.edges).toEqual([edge('p', 'b')]);
  });
});

describe('groupMembers', () => {
  it('is empty when nothing is selected', () => {
    expect(groupMembers([item('a', 0, 0)])).toEqual([]);
  });

  it('accepts a single node', () => {
    expect(groupMembers([selected(item('a', 0, 0))]).map((n) => n.id)).toEqual(['a']);
  });

  it('leaves out selected nodes whose container is also selected', () => {
    const nodes = [
      selected(frame('F', 0, 0, 300, 300)),
      selected(inside('F', frame('G', 20, 52, 200, 200))),
      selected(inside('G', item('a', 20, 52))),
      selected(item('b', 400, 0)),
    ];
    expect(groupMembers(nodes).map((n) => n.id)).toEqual(['F', 'b']);
  });

  it('is empty when the selected nodes are in different containers', () => {
    const nodes = [frame('F', 0, 0, 300, 300), selected(inside('F', item('a', 20, 52)))];
    expect(groupMembers([...nodes, selected(item('b', 400, 0))])).toEqual([]);
  });
});

describe('groupSelection', () => {
  it('frames top-level nodes without moving them on screen', () => {
    const g = graphOf(
      [item('x', 900, 900), selected(item('a', 100, 100)), selected(item('b', 300, 200))],
      [edge('a', 'b', { selected: true })],
    );
    const result = groupSelection(g, 'frame', 'F');
    expect(result.nodes.map((n) => n.id)).toEqual(['F', 'x', 'a', 'b']);
    expect(get(result, 'F')).toEqual({
      id: 'F',
      type: 'frame',
      position: { x: 80, y: 48 },
      data: { label: 'Group 1' },
      width: 340,
      height: 212,
      measured: { width: 340, height: 212 },
      selected: true,
    });
    expect(get(result, 'a')).toMatchObject({
      parentId: 'F',
      position: { x: 20, y: 52 },
      selected: false,
    });
    expect(abs(result, 'b')).toEqual({ x: 300, y: 200 });
    expect(get(result, 'x')).toBe(g.nodes[0]);
    expect(result.edges[0]?.selected).toBe(false);
    expectValid(result);
  });

  it('creates a connectable parent node for the "item" kind', () => {
    const g = graphOf([
      selected(item('a', 0, 0, { data: { label: 'Node 1' } })),
      selected(item('b', 0, 100, { data: { label: 'Node 2' } })),
    ]);
    const result = groupSelection(g, 'item', 'P');
    expect(get(result, 'P')).toMatchObject({
      type: 'item',
      data: { label: 'Node 3' },
      selected: true,
      position: { x: -20, y: -69 }, // the card sits above the box's top border, at y = 17
      width: 140,
      height: 229,
    });
    expect(absAll(result, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(result);
  });

  it('groups a single node', () => {
    const result = groupSelection(graphOf([selected(item('a', 0, 0))]), 'frame', 'F');
    expect(get(result, 'a').parentId).toBe('F');
  });

  it('nests the new container in the shared parent, growing it so nothing moves', () => {
    const g = graphOf(
      autosize([
        frame('C', 100, 100, 0, 0),
        selected(inside('C', item('a', 20, 52))),
        selected(inside('C', item('b', 200, 52))),
        inside('C', item('c', 20, 200)),
      ]),
    );
    const before = absAll(g, ['a', 'b', 'c']);
    const result = groupSelection(g, 'item', 'N');
    expect(result.nodes.map((n) => n.id)).toEqual(['C', 'N', 'a', 'b', 'c']);
    expect(get(result, 'N')).toMatchObject({ parentId: 'C', position: { x: 20, y: 52 } });
    // C grows up and left around N, whose card sits above the old members.
    expect(get(result, 'C').position).toEqual({ x: 80, y: 31 });
    expect(absAll(result, ['a', 'b', 'c'])).toEqual(before);
    expectValid(result);
  });

  it('moves a container with its contents, even when some of them are selected too', () => {
    // A marquee around a container selects the container and everything inside it.
    const g = graphOf([
      selected(frame('F', 100, 100, 300, 200)),
      selected(inside('F', item('a', 20, 52))),
      selected(item('b', 500, 100)),
    ]);
    const result = groupSelection(g, 'frame', 'G');
    expect(get(result, 'F').parentId).toBe('G');
    expect(get(result, 'a')).toEqual({ ...g.nodes[1], selected: false });
    expect(abs(result, 'a')).toEqual({ x: 120, y: 152 });
    expect(selectedIds(result)).toEqual(['G']);
    expectValid(result);
  });

  it('returns the same graph when the selection cannot be grouped', () => {
    const g = graphOf([frame('F', 0, 0, 300, 300), selected(inside('F', item('a', 20, 52)))]);
    const mixed = graphOf([...g.nodes, selected(item('b', 400, 0))]);
    expect(groupSelection(mixed, 'frame', 'G')).toBe(mixed);
    expect(groupSelection(graphOf([item('a', 0, 0)]), 'frame', 'G').nodes).toHaveLength(1);
  });
});

describe('addParent', () => {
  it('turns a frame into a parent node over the same children, without moving them', () => {
    const g = graphOf(
      autosize([
        frame('F', 100, 100, 0, 0),
        inside('F', item('a', 20, 52)),
        inside('F', item('b', 200, 52)),
        item('n', 0, 0, { data: { label: 'Node 4' }, selected: true }),
      ]),
    );
    const result = addParent(g, 'F');
    expect(get(result, 'F')).toMatchObject({
      type: 'item',
      data: { label: 'Node 5' },
      selected: true,
    });
    expect(selectedIds(result)).toEqual(['F']);
    expect(absAll(result, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(result);
  });

  it("keeps the group's top border where it was, so the card appears where the '+' was", () => {
    const g = graphOf(autosize([frame('F', 100, 100, 0, 0), inside('F', item('a', 20, 52))]));
    const parent = get(addParent(g, 'F'), 'F');
    expect(parent.position.y + ITEM_SIZE.height / 2).toBe(100);
    expect(parent.position.x).toBe(100);
  });

  it('returns the same graph for anything but a frame', () => {
    const g = graphOf([item('a', 0, 0)]);
    expect(addParent(g, 'a')).toBe(g);
    expect(addParent(g, 'missing')).toBe(g);
  });
});

describe('ungroupSelection', () => {
  it('removes a frame and selects its children, in place', () => {
    const g = graphOf([
      selected(frame('F', 100, 100, 300, 200)),
      inside('F', item('a', 20, 52)),
      inside('F', item('b', 150, 60)),
    ]);
    const result = ungroupSelection(g);
    expect(result.nodes).toEqual([selected(item('a', 120, 152)), selected(item('b', 250, 160))]);
  });

  it('keeps a parent node and its edges, back as a plain node where its card was', () => {
    const parent: GraphNode = selected({ ...item('p', 100, 100), width: 300, height: 200 });
    const g = graphOf(
      [parent, inside('p', item('a', 20, 54)), item('b', 500, 0)],
      [edge('p', 'b')],
    );
    const result = ungroupSelection(g);
    expect(get(result, 'p')).toEqual(item('p', 175, 100, { selected: false }));
    expect(get(result, 'a')).toEqual(selected(item('a', 120, 154)));
    expect(result.edges).toEqual(g.edges);
  });

  it('moves children of a nested container into the outer one', () => {
    const g = graphOf([
      frame('F', 100, 100, 400, 300),
      selected(inside('F', frame('G', 20, 52, 200, 150))),
      inside('G', item('a', 20, 52)),
    ]);
    const result = ungroupSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['F', 'a']);
    expect(get(result, 'a').parentId).toBe('F');
    expect(abs(result, 'a')).toEqual(abs(g, 'a'));
    expectValid(result);
  });

  it('ungroups only the outermost of nested selected containers', () => {
    const g = graphOf([
      selected(frame('F', 100, 100, 400, 300)),
      selected(inside('F', frame('G', 20, 52, 200, 150))),
      inside('G', item('a', 20, 52)),
    ]);
    const result = ungroupSelection(g);
    expect(result.nodes.map((n) => n.id)).toEqual(['G', 'a']);
    expect(get(result, 'a').parentId).toBe('G');
    expect(abs(result, 'a')).toEqual(abs(g, 'a'));
  });

  it('moves a selected child out of its container', () => {
    const g = graphOf([
      frame('F', 100, 100, 400, 300),
      selected(inside('F', item('a', 20, 52))),
      inside('F', item('b', 200, 52)),
    ]);
    const result = ungroupSelection(g);
    expect(get(result, 'a')).toEqual(selected(item('a', 120, 152)));
    expect(get(result, 'b').parentId).toBe('F');
    expectValid(result);
  });

  it('shrinks a parent node whose last child moves out', () => {
    const g = graphOf([
      { ...item('p', 0, 0), width: 300, height: 200 },
      selected(inside('p', item('a', 20, 52))),
    ]);
    expect(get(ungroupSelection(g), 'p').width).toBeUndefined();
  });

  it('removes a selected empty frame', () => {
    expect(ungroupSelection(graphOf([selected(frame('F', 0, 0, 100, 100))])).nodes).toEqual([]);
  });

  it('does nothing for a top-level node', () => {
    const g = graphOf([selected(item('a', 0, 0))]);
    expect(canUngroup(g.nodes)).toBe(false);
    expect(ungroupSelection(g)).toBe(g);
  });
});

describe('autosize', () => {
  it('grows every container around a child dragged past their right and bottom', () => {
    const before = nested();
    expect(before.map((n) => [n.id, n.width, n.height])).toEqual([
      ['H', 220, 316],
      ['G', 180, 244],
      ['F', 140, 172],
      ['c', undefined, undefined],
      ['d', undefined, undefined],
    ]);
    const dragged = moved(before, 'd', { x: 300, y: 200 });
    const result = autosize(dragged);
    expect(result.map((n) => [n.id, n.position, n.width, n.height])).toEqual([
      ['H', { x: 0, y: 0 }, 500, 404],
      ['G', { x: 20, y: 52 }, 460, 332],
      ['F', { x: 20, y: 52 }, 420, 260],
      ['c', { x: 20, y: 52 }, undefined, undefined],
      ['d', { x: 300, y: 200 }, undefined, undefined],
    ]);
    expect(result[3]).toBe(dragged[3]);
    expectValid(graphOf(result));
  });

  it('grows containers left and up for a child dragged past their top-left, moving nothing on screen', () => {
    const before = graphOf(nested());
    const dragged = graphOf(moved(before.nodes, 'c', { x: -60, y: -90 }));
    const result = graphOf(autosize(dragged.nodes));
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

  it('keeps the top-left corner of containers around a dragged node until the drag ends', () => {
    // React Flow only reports a drag move when the node's position in its container changes, so a
    // container that moved along with the node would swallow moves.
    const before = graphOf(nested());
    const dragging = (nodes: GraphNode[], value: boolean) =>
      nodes.map((n) => (n.id === 'c' ? { ...n, dragging: value } : n));
    const out = autosize(dragging(moved(before.nodes, 'c', { x: -60, y: 300 }), true));
    for (const id of ['H', 'G', 'F']) {
      expect(get(graphOf(out), id).position, id).toEqual(get(before, id).position);
    }
    // The right and bottom edges still follow: F now reaches down to c.
    expect(get(graphOf(out), 'F').height).toBe(300 + 40 + PADDING);
    const dropped = graphOf(autosize(dragging(out, false)));
    expect(absAll(dropped, ['c', 'd'])).toEqual(absAll(graphOf(out), ['c', 'd']));
    expectValid(dropped);
  });

  it('shrinks a childless frame to EMPTY_FRAME and turns a childless parent node into its card', () => {
    const result = autosize([
      frame('F', 100, 100, 400, 300),
      { ...item('p', 0, 0), width: 300, height: 200 },
    ]);
    expect(result[0]).toMatchObject({ position: { x: 100, y: 100 }, ...EMPTY_FRAME });
    expect(result[1]).toEqual(item('p', 75, 0));
  });

  it('returns the same array when every container fits', () => {
    const nodes = graphOf([...nested(), item('z', -500, -500)]).nodes;
    expect(autosize(nodes)).toBe(nodes);
    expect(autosize([])).toEqual([]);
  });
});

describe('containerAt', () => {
  const nodes = [
    frame('F', 0, 0, 500, 400),
    inside('F', frame('G', 20, 52, 200, 200)),
    frame('H', 400, 300, 300, 300),
    item('p', 1000, 0, { width: 200, height: 200, measured: { width: 200, height: 200 } }),
    inside('p', item('c', 20, 52)),
    item('leaf', 1000, 500),
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
