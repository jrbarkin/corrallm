import { describe, expect, it } from 'vitest';

import { EXAMPLES } from '../examples';
import { TEST_CATALOG } from '../test-model';
import type { CanvasId } from '../canvas';
import type { AgentData, AgentNode, CanvasDocument, CanvasNode } from './canvas';
import { fromFile } from './file';
import { absolutePosition, CARD_SIZE, autosize } from './geometry';
import { insert } from './insert';
import type { QueueItem, QueueRepeat, Until } from './queue';
import { workspaceOwners } from './workspaces';

const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
type Graph = Pick<CanvasDocument, 'nodes' | 'links'>;
const document = (graph: Graph): CanvasDocument => ({ id: ID, arrange: false, ...graph });
const agent = (id: string, x: number, y: number, data: Partial<AgentData> = {}): AgentNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id, ...data },
});
const frame = (id: string, label = id): CanvasNode => ({
  id,
  type: 'frame',
  position: { x: 10, y: 20 },
  data: { label, color: 2 },
});
const loop = (inner: QueueItem[], until: Until = { kind: 'succeeded' }): QueueItem => ({
  id: 'loop',
  repeat: inner as QueueRepeat['repeat'],
  until,
  rounds: 2,
  otherwise: 'goOn',
});
const part = document({
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
});
const ids = () => {
  let n = 0;
  return () => 'new-' + String(++n);
};

describe('template roots', () => {
  it('inserts the own roots beside existing content and retargets work without a wrapper', () => {
    const changed = insert(
      document({ nodes: [agent('a', 0, 0)], links: [] }),
      part,
      {},
      { newId: ids() },
    );
    expect(changed.result).toEqual({ roots: ['new-1', 'new-2'], select: ['new-1', 'new-2'] });
    const [existing, x, y] = changed.next.nodes;
    expect(changed.next.nodes).toHaveLength(3);
    expect(existing?.id).toBe('a');
    if (x?.type !== 'agent' || y?.type !== 'agent') throw new Error('No inserted agents');
    expect([x.id, y.id, x.parentId, y.parentId]).toEqual(['new-1', 'new-2', undefined, undefined]);
    expect(x.position.x).toBeGreaterThan(CARD_SIZE.width);
    expect(y.position.y - x.position.y).toBe(200);
    expect(x.data.queue).toEqual([
      { id: 'hand', message: 'Over to you', target: 'new-2' },
      loop([], { kind: 'repeatEnds', agent: 'new-2', item: 'loop' }),
    ]);
    expect(y.data.queue).toEqual([
      { id: 'w', waitFor: [{ agent: 'new-1', item: 'hand' }] },
      loop([
        { id: 'again', waitFor: [{ agent: 'new-1' }] },
        { id: 'back', message: 'Back to you', target: 'new-1' },
      ]),
    ]);
    expect(changed.next.links).toEqual([{ source: 'new-1', target: 'new-2' }]);
  });

  it('keeps the template frames and labels on repeated insertion, minting every node exactly once', () => {
    const source = document({
      nodes: [frame('team', 'Team'), { ...agent('x', 20, 52), parentId: 'team' }],
      links: [],
    });
    const newId = ids();
    const once = insert(document({ nodes: [], links: [] }), source, {}, { newId });
    const twice = insert(once.next, source, {}, { newId });
    expect(once.result).toEqual({ roots: ['new-1'], select: ['new-1'] });
    expect(twice.result).toEqual({ roots: ['new-3'], select: ['new-3'] });
    expect(
      twice.next.nodes.map(({ id, type, data, parentId }) => ({
        id,
        type,
        label: data.label,
        parentId,
      })),
    ).toEqual([
      { id: 'new-1', type: 'frame', label: 'Team', parentId: undefined },
      { id: 'new-2', type: 'agent', label: 'x', parentId: 'new-1' },
      { id: 'new-3', type: 'frame', label: 'Team', parentId: undefined },
      { id: 'new-4', type: 'agent', label: 'x', parentId: 'new-3' },
    ]);
    expect(twice.next.nodes[2]?.position.x).toBeGreaterThan(
      once.next.nodes[0]?.position.x ?? Infinity,
    );
  });

  it.each(EXAMPLES)(
    'preserves $name workspace owners and root order, nesting roots only when a parent is given',
    (example) => {
      const source = fromFile(example.text, TEST_CATALOG, 'claude-code');
      const parent = frame('parent');
      for (const into of [undefined, parent.id]) {
        const changed = insert(
          document({ nodes: [parent], links: [] }),
          source,
          into === undefined ? {} : { parent: into },
          { newId: ids() },
        );
        const added = changed.next.nodes.filter(({ id }) => id !== parent.id);
        expect(added).toHaveLength(source.nodes.length);
        const renamed = new Map(source.nodes.map((node, i) => [node.id, added[i]?.id]));
        const roots = source.nodes
          .filter(({ parentId }) => parentId === undefined)
          .map(({ id }) => renamed.get(id));
        expect(changed.result).toEqual({ roots, select: roots });
        for (const [i, node] of source.nodes.entries()) {
          expect(added[i]).toMatchObject({ type: node.type, data: { label: node.data.label } });
          expect(added[i]?.parentId).toBe(
            node.parentId === undefined ? into : renamed.get(node.parentId),
          );
        }
        if (into === undefined) {
          expect(
            workspaceOwners(document({ nodes: added, links: [] })).map(({ agents }) => agents),
          ).toEqual(
            workspaceOwners(source).map(({ agents }) => agents.map((id) => renamed.get(id))),
          );
        } else expect(workspaceOwners(changed.next)).toHaveLength(1);
      }
    },
  );
});

it('grows a named parent without moving its existing children in canvas coordinates', () => {
  const base = document({
    nodes: [frame('outer'), { ...agent('old', 20, 52), parentId: 'outer' }],
    links: [],
  });
  const changed = insert(base, part, { parent: 'outer' }, { newId: ids() });
  const before = new Map(base.nodes.map((node) => [node.id, node]));
  const after = new Map(changed.next.nodes.map((node) => [node.id, node]));
  const old = base.nodes[1];
  if (!old) throw new Error('No old child');
  expect(absolutePosition(after.get(old.id) ?? old, after)).toEqual(absolutePosition(old, before));
  expect(
    changed.next.nodes.filter((node) => node.id.startsWith('new-')).map(({ parentId }) => parentId),
  ).toEqual(['outer', 'outer']);
  expect(autosize(changed.next.nodes).map((node) => node.position)).toEqual(
    changed.next.nodes.map((node) => node.position),
  );
});

it('keeps existing objects and unchanged queue items, minting nothing for an absent parent', () => {
  const existing = agent('a', 0, 0);
  const unchanged = { id: 'm', message: 'No references' };
  const base = document({ nodes: [existing], links: [] });
  const source = document({ nodes: [agent('x', 0, 0, { queue: [unchanged] })], links: [] });
  const next = insert(base, source, {}, { newId: ids() }).next;
  expect(next.nodes[0]).toBe(existing);
  expect(next.nodes[1]?.data).toBe(source.nodes[0]?.data);
  expect(
    insert(
      base,
      source,
      { parent: 'missing' },
      {
        newId: () => {
          throw new Error('must not mint');
        },
      },
    ),
  ).toEqual({ next: base, result: { roots: [] } });
});
