import { expect, it } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { toRows } from '../../shared/model/rows';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { Entities, Entity } from '../../shared/model/state';
import { absolutePosition } from '../../shared/model/geometry';
import { group } from '../../shared/model/structure';
import { CanvasFlow, nodeView } from './flow';
import type { Graph, GraphNode } from './flow';
import { EMPTY_SELECTION, projectSelection, selectOnly } from './selection';
import { projectOverlay } from './overlay';

it('projects only changed entities, including queue changes, and keeps metadata from the mirror', () => {
  const id = newCanvasId();
  const doc: CanvasDocument = {
    id,
    arrange: true,
    nodes: ['a', 'b'].map((id) => ({
      id,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        label: id,
        queue: [
          { id: 'work', message: 'Original' },
          { id: 'untouched', message: 'Keep' },
        ],
      },
    })),
    links: [{ source: 'a', target: 'b' }],
  };
  const rows = Object.fromEntries(
    Object.entries(toRows(doc)).map(([key, value]) => [key, { ...value, rev: 1, by: 'you' }]),
  ) as Entities;
  const flow = new CanvasFlow();
  const first = flow.read(id, 1, rows);
  const next = flow.read(id, 2, {
    ...rows,
    'item/a/work': { ...rows['item/a/work'], body: { message: 'New' }, rev: 2 } as Entity,
  });
  expect(next.document.nodes[1]).toBe(first.document.nodes[1]);
  expect(next.graph.nodes[1]).toBe(first.graph.nodes[1]);
  expect(next.graph.edges[0]).toBe(first.graph.edges[0]);
  expect(
    next.document.nodes[0]?.type === 'agent' ? next.document.nodes[0].data.queue?.[0] : undefined,
  ).toEqual({ id: 'work', message: 'New' });
  const a = next.document.nodes[0],
    old = first.document.nodes[0];
  if (a?.type !== 'agent' || old?.type !== 'agent') throw new Error('No agent');
  expect(a.data.queue?.[1]).toBe(old.data.queue?.[1]);
  const meta = flow.read(id, 3, {
    ...rows,
    meta: {
      arrange: true,
      name: 'Team.corral',
      edited: true,
      project: { name: 'project', path: '/project' },
      rev: 3,
      by: 'you',
    },
  });
  expect(meta.meta).toMatchObject({
    arrange: true,
    name: 'Team.corral',
    edited: true,
    project: { name: 'project' },
  });
});

it('keeps selection, measurements and dragging outside the document, preserving arrange', () => {
  const id = newCanvasId();
  const rows = {
    meta: { arrange: true, name: null, edited: false, project: null, rev: 1, by: 'you' },
    'node/a': { id: 'a', kind: 'agent', label: 'A', place: 0, x: 1, y: 2, rev: 1, by: 'you' },
  } as Entities;
  const projected = new CanvasFlow().read(id, 1, rows);
  const selected = projectSelection(projected.graph, selectOnly(EMPTY_SELECTION, 'a'));
  const moved = projectOverlay(
    selected,
    new Map([
      ['a', { position: { x: 200, y: 300 }, dragging: true, measured: { width: 150, height: 34 } }],
    ]),
  );
  expect(moved.nodes[0]).toMatchObject({
    selected: true,
    position: { x: 200, y: 300 },
    dragging: true,
  });
  expect(projected.document).toMatchObject({
    arrange: true,
    nodes: [{ position: { x: 1, y: 2 } }],
  });
  expect(projected.document.nodes[0]).not.toHaveProperty('selected');
  expect(projected.document.nodes[0]).not.toHaveProperty('measured');
  expect(projectSelection(projected.graph, EMPTY_SELECTION).nodes[0]).toBe(
    projected.graph.nodes[0],
  );
});

it('projects display-only queue data onto a card without changing its model or untouched cards', () => {
  const node: GraphNode = {
    id: 'a',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: 'A' },
  };
  const data = { ...node.data, queue: [{ id: 'manual', message: 'Human note' }] };
  const shown = nodeView(node, '', 'A', data);
  expect(shown.data.queue).toEqual([{ id: 'manual', message: 'Human note' }]);
  expect(node.data.queue).toBeUndefined();
  expect(nodeView(node, '', 'A', data)).toBe(shown);
  const other: GraphNode = { ...node, id: 'b' };
  const untouched = nodeView(other, '', 'B');
  nodeView(node, '', 'A', { ...data, queue: [] });
  expect(nodeView(other, '', 'B')).toBe(untouched);
});

it('fits a dragged child’s containers in the overlay while leaving model and other cards in place', () => {
  const graph = {
    nodes: [
      {
        id: 'F',
        type: 'frame' as const,
        position: { x: 0, y: 0 },
        width: 340,
        height: 200,
        data: { label: 'Group' },
      },
      {
        id: 'a',
        type: 'agent' as const,
        parentId: 'F',
        position: { x: 20, y: 52 },
        data: { label: 'A' },
      },
      {
        id: 'b',
        type: 'agent' as const,
        parentId: 'F',
        position: { x: 170, y: 140 },
        data: { label: 'B' },
      },
    ],
    edges: [],
  };
  const shown = projectOverlay(
    graph,
    new Map([['a', { position: { x: 450, y: 100 }, dragging: true }]]),
  );
  expect(shown.nodes[0]?.width).toBe(620);
  expect(shown.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  expect(shown.nodes[2]).toBe(graph.nodes[2]);
  expect(graph.nodes[0]?.width).toBe(340);
});

it('projects grouped frames in parent-relative coordinates without moving their cards', () => {
  const id = newCanvasId();
  let doc: CanvasDocument = {
    id,
    arrange: false,
    links: [],
    nodes: [
      { id: 'a', type: 'agent', position: { x: 225, y: 183 }, data: { label: 'A' } },
      { id: 'b', type: 'agent', position: { x: 225, y: 303 }, data: { label: 'B' } },
      { id: 'c', type: 'agent', position: { x: 625, y: 183 }, data: { label: 'C' } },
      { id: 'd', type: 'agent', position: { x: 625, y: 303 }, data: { label: 'D' } },
    ],
  };
  const flow = new CanvasFlow();
  let rev = 0;
  const read = () =>
    flow.read(
      id,
      ++rev,
      Object.fromEntries(
        Object.entries(toRows(doc)).map(([key, row]) => [key, { ...row, rev, by: 'you' }]),
      ) as Entities,
    ).graph;
  const nodeOf = (graph: Graph, name: string) => {
    const node = graph.nodes.find((n) => n.id === name);
    if (!node) throw new Error(`No node ${name}`);
    return node;
  };
  const position = (graph: Graph, name: string) =>
    absolutePosition(nodeOf(graph, name), new Map(graph.nodes.map((n) => [n.id, n])));
  const before = position(read(), 'a');
  const context = (id: string) => ({ newId: () => id, defaultAdapter: 'claude-code' });
  doc = group(doc, { nodes: ['a', 'b'], kind: 'frame' }, context('first')).next;
  read();
  doc = group(doc, { nodes: ['c', 'd'], kind: 'frame' }, context('second')).next;
  read();
  doc = group(doc, { nodes: ['first', 'second'], kind: 'frame' }, context('outer')).next;
  const shown = read();
  expect(position(shown, 'a')).toEqual(before);
  const outer = nodeOf(shown, 'outer');
  for (const name of ['first', 'second']) {
    const inner = nodeOf(shown, name);
    expect(inner.parentId).toBe('outer');
    expect(position(shown, name).x).toBeGreaterThan(outer.position.x);
    expect(position(shown, name).x + (inner.width ?? 0)).toBeLessThan(
      outer.position.x + (outer.width ?? 0),
    );
  }
});
