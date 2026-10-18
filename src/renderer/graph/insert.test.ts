import { describe, expect, it } from 'vitest';

import { absolutePosition, CARD_SIZE, edgeId } from './graph';
import type { Graph, GraphNode } from './graph';
import { insertGraph } from './insert';
import type { QueueItem, QueueRepeat, Until } from '../../shared/model/queue';

const agent = (
  id: string,
  x: number,
  y: number,
  data: Partial<GraphNode['data']> = {},
): GraphNode => ({
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
  edges: [{ id: edgeId('x', 'y'), source: 'x', target: 'y' }],
};

const ids = () => {
  let n = 0;
  return () => `new-${String((n += 1))}`;
};

describe('insertGraph', () => {
  it('adds a canvas as one new group, right of what is there, its agents and links renamed', () => {
    const canvas: Graph = { nodes: [agent('a', 0, 0, { queue: [] })], edges: [] };
    const { nodes, edges } = insertGraph(canvas, part, {
      group: 'g',
      name: 'TDD relay',
      newId: ids(),
    });
    const byLabel = (label: string) => nodes.find((n) => n.data.label === label);
    const group = nodes.find((n) => n.id === 'g');
    expect(group).toMatchObject({ type: 'frame', data: { label: 'TDD relay' } });
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['g']);
    // Right of the agent already there, its own agents inside it, laid out as in the part.
    expect(group?.position.x).toBeGreaterThan(CARD_SIZE.width);
    const [x, y] = [byLabel('x'), byLabel('y')];
    if (!x || !y) throw new Error('the part is missing');
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
    expect(edges.map((e) => [e.source, e.target])).toEqual([['new-1', 'new-2']]);
  });

  it('names the group apart from one already named so, and starts an empty canvas at its corner', () => {
    const once = insertGraph({ nodes: [], edges: [] }, part, {
      group: 'g1',
      name: 'TDD relay',
      newId: ids(),
    });
    expect(once.nodes.find((n) => n.id === 'g1')?.position).toEqual({ x: 0, y: 0 });
    const twice = insertGraph(once, part, { group: 'g2', name: 'TDD relay', newId: ids() });
    expect(twice.nodes.find((n) => n.id === 'g2')?.data.label).toBe('TDD relay 2');
  });
});
