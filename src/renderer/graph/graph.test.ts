import type { Edge, XYPosition } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { absolutePosition } from '../../shared/model/geometry';
import { autosize, size } from './geometry';

import {
  addAgent,
  documentOf,
  graphOf,
  addParent,
  canvasNodes,
  connect,
  deleteSelection,
  groupSelection,
  renameNode,
  selectOnly,
  ungroupSelection,
} from './graph';
import { HEADER, CARD_SIZE, PADDING } from '../../shared/model/geometry';
import type { Graph, GraphNode } from './graph';
import type { CanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { insertGraph } from './insert';

it('carries arrangement between the graph and its model', () => {
  const graph = { nodes: [], edges: [], arrange: true };
  const model = documentOf(graph, '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId);
  expect(model).toHaveProperty('arrange', true);
  expect(graphOf(model)).toEqual(graph);
});

it.each(['add', 'delete', 'group', 'parent', 'ungroup', 'insert'] as const)(
  'keeps arrangement through %s',
  (change) => {
    const graph = {
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 200, 0, { selected: true })],
      edges: [],
      arrange: true,
    };
    const grouped = { ...groupSelection(graph, 'frame', 'G'), arrange: true };
    const result =
      change === 'add'
        ? addAgent(graph, 'c', { x: 500, y: 200 })
        : change === 'delete'
          ? deleteSelection(graph)
          : change === 'group'
            ? groupSelection(graph, 'frame', 'G')
            : change === 'parent'
              ? addParent(grouped, 'G')
              : change === 'ungroup'
                ? ungroupSelection(grouped)
                : insertGraph(
                    graph,
                    { nodes: [], edges: [] },
                    { group: 'G', name: 'Template', newId: () => 'new' },
                  );
    expect(result).toHaveProperty('arrange', true);
  },
);

/** An item measured at 100×40. */
function agentNode(id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: 'agent',
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
function frozen(nodes: GraphNode[], edges: Edge[] = []): Graph {
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
    const top = (node.type === 'frame' ? 0 : CARD_SIZE.height / 2) + HEADER + PADDING;
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
    inside('F', agentNode('c', 20, 52)),
    inside('F', agentNode('d', 20, 112)),
  ]);
}

/** `nodes` with node `id` moved to `position`, as a drag would leave it. */
function moved(nodes: GraphNode[], id: string, position: XYPosition): GraphNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, position } : n));
}

describe('selectOnly', () => {
  it('selects only that node, deselecting other nodes and every edge', () => {
    const g = frozen(
      [selected(agentNode('a', 0, 0)), selected(agentNode('b', 0, 100)), agentNode('c', 0, 200)],
      [edge('a', 'b', { selected: true })],
    );
    const result = selectOnly(g, 'b');
    expect(selectedIds(result)).toEqual(['b']);
    expect(result.edges[0]?.selected).toBe(false);
    expect(get(result, 'b')).toBe(get(g, 'b'));
    expect(get(result, 'c')).toBe(get(g, 'c'));
  });

  it('returns the same graph when that node is already the only selected element', () => {
    const g = frozen([agentNode('a', 0, 0), selected(agentNode('b', 0, 100))], [edge('a', 'b')]);
    expect(selectOnly(g, 'b')).toBe(g);
  });
});

describe('autosize during a drag', () => {
  it('keeps the top-left corner of containers around a dragged node until the drag ends', () => {
    // React Flow only reports a drag move when the node's position in its container changes, so a
    // container that moved along with the node would swallow moves.
    const before = frozen(nested());
    const dragging = (nodes: GraphNode[], value: boolean) =>
      nodes.map((n) => (n.id === 'c' ? { ...n, dragging: value } : n));
    const out = autosize(dragging(moved(before.nodes, 'c', { x: -60, y: 300 }), true));
    for (const id of ['H', 'G', 'F']) {
      expect(get(frozen(out), id).position, id).toEqual(get(before, id).position);
    }
    // The right and bottom edges still follow: F now reaches down to c.
    expect(get(frozen(out), 'F').height).toBe(300 + 40 + PADDING);
    const dropped = frozen(autosize(dragging(out, false)));
    expect(absAll(dropped, ['c', 'd'])).toEqual(absAll(frozen(out), ['c', 'd']));
    expectValid(dropped);
  });
});

describe('canvasNodes', () => {
  it('are the model’s nodes: agents and groups, without how the view draws them', () => {
    const { nodes } = frozen([
      selected(frame('F', 0, 0, 300, 200)),
      inside(
        'F',
        agentNode('a', 20, 52, {
          data: {
            label: 'Builder',
            adapter: 'codex',
            connection: 'codex.app-server',
            role: 'Builds',
            queue: [{ id: 'm', message: 'Build it' }],
            color: 2,
          },
          dragging: true,
        }),
      ),
      agentNode('b', 400, 0),
    ]);
    expect(canvasNodes(nodes)).toEqual([
      { id: 'F', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'F' } },
      {
        id: 'a',
        type: 'agent',
        position: { x: 20, y: 52 },
        parentId: 'F',
        data: {
          label: 'Builder',
          adapter: 'codex',
          connection: 'codex.app-server',
          role: 'Builds',
          queue: [{ id: 'm', message: 'Build it' }],
          color: 2,
        },
      },
      { id: 'b', type: 'agent', position: { x: 400, y: 0 }, data: { label: 'b' } },
    ]);
  });

  it('keep a group’s label and colour, and nothing only an agent has, on a frame', () => {
    const team = {
      ...frame('F', 0, 0, 100, 100),
      data: { label: 'Team', color: 3, queue: [{ id: 'm', message: 'Stray' }] },
    };
    expect(canvasNodes(frozen([team]).nodes)).toEqual([
      { id: 'F', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team', color: 3 } },
    ]);
  });
});

describe('a canvas, drawn', () => {
  const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
  /** A group holding an agent, another agent outside it, and a link between the two. */
  const canvas: CanvasDocument = {
    id: ID,
    arrange: false,
    nodes: [
      { id: 'G', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Team', color: 2 } },
      {
        id: 'a',
        type: 'agent',
        parentId: 'G',
        position: { x: 20, y: 52 },
        data: { label: 'Coder', adapter: 'codex' },
      },
      { id: 'b', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'Reviewer' } },
    ],
    links: [{ source: 'a', target: 'b', dots: ['bottom', 'top'] }],
  };

  it('draws a canvas with its groups sized to fit what they hold, and its links as edges', () => {
    const graph = graphOf(canvas);
    expectValid(graph);
    expect(graph.nodes.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      {
        id: 'G',
        width: PADDING + CARD_SIZE.width + PADDING,
        height: HEADER + PADDING + CARD_SIZE.height + PADDING,
      },
      { id: 'a', width: undefined, height: undefined },
      { id: 'b', width: undefined, height: undefined },
    ]);
    expect(graph.edges).toEqual([
      { id: 'a->b', source: 'a', target: 'b', sourceHandle: 'bottom', targetHandle: 'top' },
    ]);
  });

  it('keeps of a graph what the model keeps: no selection, sizes or edge ids', () => {
    const graph = graphOf(canvas);
    expect(documentOf(graph, ID)).toEqual(canvas);
    const drawn: Graph = {
      nodes: graph.nodes.map((n) => ({ ...n, selected: true, dragging: false })),
      edges: graph.edges.map((e) => ({ ...e, selected: true })),
    };
    expect(documentOf(drawn, ID)).toEqual(canvas);
    // An edge drawn without its dots keeps none.
    expect(documentOf({ ...graph, edges: [edge('a', 'b')] }, ID).links).toEqual([
      { source: 'a', target: 'b' },
    ]);
  });
});

describe('model edit projection', () => {
  it('keeps view measurements and applies selection hints while grouping model nodes', () => {
    const g = frozen([selected(agentNode('a', 100, 100)), selected(agentNode('b', 300, 200))]);
    const grouped = groupSelection(g, 'frame', 'F');
    expect(get(grouped, 'F')).toMatchObject({
      width: 340,
      height: 212,
      measured: { width: 340, height: 212 },
      selected: true,
    });
    expect(get(grouped, 'a').measured).toBe(g.nodes[0]?.measured);
    expect(selectedIds(grouped)).toEqual(['F']);
    expect(absAll(grouped, ['a', 'b'])).toEqual(absAll(g, ['a', 'b']));
    expectValid(grouped);
  });
  it('keeps untouched view nodes identical during a rename and a link edit', () => {
    const g = frozen([
      selected(agentNode('a', 0, 0)),
      agentNode('b', 300, 0),
      frame('F', 600, 0, 100, 100),
    ]);
    const renamed = renameNode(g, 'a', 'Edited');
    expect(get(renamed, 'F')).toBe(g.nodes[2]);
    expect(get(renamed, 'a').selected).toBe(true);
    expect(get(renamed, 'a').measured).toBe(g.nodes[0]?.measured);
    const linked = connect(g, { source: 'a', target: 'b' });
    expect(linked.nodes).toBe(g.nodes);
    expect(get(linked, 'F')).toBe(g.nodes[2]);
    const renamedFrame = renameNode(g, 'F', 'Edited frame');
    expect(get(renamedFrame, 'F')).toMatchObject({ width: 100, height: 100 });
    expect(renamedFrame.edges).toBe(g.edges);
  });
});
