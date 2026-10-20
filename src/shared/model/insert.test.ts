import { describe, expect, it } from 'vitest';

import { absolutePosition, CARD_SIZE, autosize } from './geometry';
import type { AgentData, AgentNode, CanvasDocument } from './canvas';
import { insert } from './insert';
import type { QueueItem, QueueRepeat, Until } from './queue';
import type { CanvasId } from '../canvas';
const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
type Graph = Pick<CanvasDocument, 'nodes' | 'links'>;
const document = (graph: Graph): CanvasDocument => ({ id: ID, arrange: false, ...graph });
const insertGraph = (
  graph: Graph,
  part: Graph,
  options: { group: string; name: string; newId: () => string },
) => {
  let first = true;
  return insert(
    document(graph),
    document(part),
    { name: options.name },
    {
      newId: () => {
        const id = first ? options.group : options.newId();
        first = false;
        return id;
      },
    },
  ).next;
};

const agent = (id: string, x: number, y: number, data: Partial<AgentData> = {}): AgentNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id, ...data },
});

/** A two-agent part: x hands y a message, and y waits for it, then loops waiting and handing back. */
const loop = (inner: QueueItem[], until: Until = { kind: 'succeeded' }): QueueItem => ({
  id: 'loop',
  repeat: inner as QueueRepeat['repeat'],
  until,
  rounds: 2,
  otherwise: 'goOn',
});
const part: Graph = {
  nodes: [
    agent('x', 100, 50, {
      queue: [
        { id: 'hand', message: 'Over to you', target: 'y' },
        loop([], { kind: 'repeatEnds', agent: 'y', item: 'loop' }),
      ],
    }),
    agent('y', 100, 250, {
      queue: [
        { id: 'w', waitFor: [{ agent: 'x', item: 'hand' }] },
        loop([
          { id: 'again', waitFor: [{ agent: 'x' }] },
          { id: 'back', message: 'Back to you', target: 'x' },
        ]),
      ],
    }),
  ],
  links: [{ source: 'x', target: 'y' }],
};

const ids = () => {
  let n = 0;
  return () => `new-${String((n += 1))}`;
};

describe('insertGraph', () => {
  it('adds a canvas as one new group, right of what is there, its agents and links renamed', () => {
    const canvas: Graph = { nodes: [agent('a', 0, 0, { queue: [] })], links: [] };
    const { nodes, links } = insertGraph(canvas, part, {
      group: 'g',
      name: 'TDD relay',
      newId: ids(),
    });
    const byLabel = (label: string) => nodes.find((n) => n.data.label === label);
    const group = nodes.find((n) => n.id === 'g');
    expect(group).toMatchObject({ type: 'frame', data: { label: 'TDD relay' } });
    // Right of the agent already there, its own agents inside it, laid out as in the part.
    expect(group?.position.x).toBeGreaterThan(CARD_SIZE.width);
    const [x, y] = [byLabel('x'), byLabel('y')];
    if (x?.type !== 'agent' || y?.type !== 'agent') throw new Error('the part is missing');
    expect([x.id, y.id, x.parentId, y.parentId]).toEqual(['new-1', 'new-2', 'g', 'g']);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(absolutePosition(y, byId).y - absolutePosition(x, byId).y).toBe(200);
    // What pointed at x and y points at their new selves.
    expect(x.data.queue).toEqual([
      { id: 'hand', message: 'Over to you', target: 'new-2' },
      // The repeat it goes round with.
      loop([], { kind: 'repeatEnds', agent: 'new-2', item: 'loop' }),
    ]);
    expect(y.data.queue).toEqual([
      { id: 'w', waitFor: [{ agent: 'new-1', item: 'hand' }] },
      // Inside a repeat too.
      loop([
        { id: 'again', waitFor: [{ agent: 'new-1' }] },
        { id: 'back', message: 'Back to you', target: 'new-1' },
      ]),
    ]);
    expect(links.map((e) => [e.source, e.target])).toEqual([['new-1', 'new-2']]);
  });

  it('names the group apart from one already named so, and starts an empty canvas at its corner', () => {
    const once = insertGraph({ nodes: [], links: [] }, part, {
      group: 'g1',
      name: 'TDD relay',
      newId: ids(),
    });
    expect(once.nodes.find((n) => n.id === 'g1')?.position).toEqual({ x: 0, y: 0 });
    const twice = insertGraph(once, part, { group: 'g2', name: 'TDD relay', newId: ids() });
    expect(twice.nodes.find((n) => n.id === 'g2')?.data.label).toBe('TDD relay 2');
  });
});

it('inserts into a named parent, grows its ancestors, and returns a selection hint', () => {
  const base = insertGraph({ nodes: [], links: [] }, part, {
    group: 'outer',
    name: 'Outer',
    newId: ids(),
  });
  let n = 0;
  const changed = insert(
    base,
    document(part),
    { name: 'Nested', parent: 'outer' },
    { newId: () => `nested-${String(++n)}` },
  );
  expect(changed.result).toEqual({ id: 'nested-1', select: ['nested-1'] });
  expect(changed.next.nodes.find((node) => node.id === 'nested-1')?.parentId).toBe('outer');
  const before = new Map(base.nodes.map((node) => [node.id, node]));
  const after = new Map(changed.next.nodes.map((node) => [node.id, node]));
  for (const node of base.nodes.filter((node) => node.type === 'agent')) {
    expect(absolutePosition(after.get(node.id) ?? node, after)).toEqual(
      absolutePosition(node, before),
    );
  }
  expect(autosize(changed.next.nodes).map((node) => node.position)).toEqual(
    changed.next.nodes.map((node) => node.position),
  );
});

it('keeps existing entities and unmodified imported queue items identical, minting nothing for an absent parent', () => {
  const existing = agent('a', 0, 0, { queue: [] });
  const unchanged = { id: 'm', message: 'No references' };
  const base = document({ nodes: [existing], links: [] });
  const part = document({ nodes: [agent('x', 0, 0, { queue: [unchanged] })], links: [] });
  let count = 0;
  const next = insert(base, part, { name: 'New' }, { newId: () => `id-${String(++count)}` }).next;
  expect(next.nodes[0]).toBe(existing);
  expect(next.links).toEqual([]);
  const imported = next.nodes.find((node) => node.id === 'id-2');
  expect(imported?.data).toBe(part.nodes[0]?.data);
  expect(
    insert(
      base,
      part,
      { name: 'No', parent: 'missing' },
      {
        newId: () => {
          throw new Error('must not mint');
        },
      },
    ).next,
  ).toBe(base);
});
