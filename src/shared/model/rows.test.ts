import { describe, expect, it } from 'vitest';

import { CANVAS_VERSION } from '../canvas';
import type { CanvasId } from '../canvas';
import { TEST_CATALOG } from '../test-model';
import { EXAMPLES } from '../examples';
import type { AgentNode, CanvasDocument, CanvasNode } from './canvas';
import { fromFile, toFile } from './file';
import type { QueueItem } from './queue';
import { diffRows, fromRows, itemKey, linkKey, META, nodeKey, rowsFault, toRows } from './rows';
import type { ItemRow, LinkRow, NodeRow, Rows } from './rows';

/*
 * A canvas's document as the rows the core keeps it in (B9 Design §2) and its topics carry: one row
 * an entity, by key, read back by the same function wherever it is read.
 */

const ID = '3f1b0d6e-8c2a-4e7f-9b5d-1a2c3e4f5a6b' as CanvasId;

it('keeps fallback and handoff fields through canonical document rows', () => {
  const document: CanvasDocument = {
    id: ID,
    arrange: false,
    links: [],
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'A',
          fallback: { to: [{ adapter: 'future', connection: 'future.api' }], back: 'return' },
          handoff: { at: 95, file: 'handoff.md' },
        },
      },
    ],
  };
  const rows = toRows(document);
  expect(fromRows(ID, rows)).toEqual(document);
  expect(diffRows(rows, document).changed).toEqual([]);
});

/** Every item a queue may hold, its if-thens and repeats holding what they may. */
const everyItem: QueueItem[] = [
  { id: 'spec', message: 'Write the spec', target: 'worker/1' },
  { id: 'check', action: 'Bash', target: 'worker/1', instruction: 'npm test', expect: 'fails' },
  {
    id: 'if-red',
    if: { kind: 'outputContains', text: 'RED', wholeLine: true },
    then: [
      { id: 'fix', action: 'Edit' },
      { id: 'tell', message: 'Fix it', target: 'worker/1' },
    ],
  },
  {
    id: 'joined',
    waitFor: [{ agent: 'worker/1' }, { agent: 'Ünïcode 𝔸', item: 'review' }],
    timeout: { resets: 'fiveHour', backend: 'codex' },
  },
  { id: 'later', delay: { at: '09:00' } },
  { id: 'ok', approve: 'the spec' },
  {
    id: 'loop',
    repeat: [
      { id: 'again', message: 'Again' },
      { id: 'waited', waitFor: [{ agent: 'worker/1', item: 'x' }], timeout: { seconds: 60 } },
      { id: 'pause', delay: { seconds: 30 } },
      { id: 'run', action: 'Bash' },
    ],
    until: { kind: 'repeatEnds', agent: 'Ünïcode 𝔸', item: 'rounds' },
    rounds: 3,
    otherwise: 'ask',
  },
  {
    id: 'if-usage',
    if: { kind: 'usageAbove', backend: 'claude-code', window: 'weekly', percent: 80 },
    then: [],
  },
];

/**
 * A canvas holding everything a canvas may: a frame, an agent heading a group of its own, agents of
 * an adapter no build has, ids a key must escape, links drawn from either end, and its arrangement.
 */
const everything: CanvasDocument = {
  id: ID,
  arrange: true,
  nodes: [
    { id: 'team', type: 'frame', position: { x: -40, y: 12.5 }, data: { label: 'Team', color: 3 } },
    {
      id: 'lead',
      type: 'agent',
      parentId: 'team',
      position: { x: 20, y: 52 },
      data: {
        label: 'Lead',
        adapter: 'codex',
        connection: 'codex.app-server',
        settings: {
          codex: { model: 'gpt-6-luna', effort: 'low', mode: 'read-only' },
          'claude-code': { mode: 'plan' },
        },
        role: 'Lead the team.',
        color: 1,
        queue: everyItem,
      },
    },
    {
      id: 'worker/1',
      type: 'agent',
      parentId: 'lead',
      position: { x: 0, y: 200 },
      data: {
        label: 'Worker',
        adapter: 'made-up',
        connection: 'made-up.cli',
        settings: { 'made-up': { mode: 'careful' } },
        queue: [{ id: 'x', action: 'Read' }],
      },
    },
    { id: 'Ünïcode 𝔸', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'Unicode' } },
    { id: '\uFFFD', type: 'agent', position: { x: 900, y: 0 }, data: { label: 'Replacement' } },
  ],
  links: [
    { source: 'worker/1', target: 'lead', dots: ['top', 'bottom'] },
    { source: 'Ünïcode 𝔸', target: '\uFFFD' },
    { source: 'lead', target: 'Ünïcode 𝔸' },
  ],
};

/** A canvas of one agent `a` with `queue`, and another, `b`. */
const queued = (queue: QueueItem[]): CanvasDocument => ({
  id: ID,
  arrange: false,
  nodes: [
    { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A', queue } },
    { id: 'b', type: 'agent', position: { x: 300, y: 0 }, data: { label: 'B' } },
  ],
  links: [],
});
const message = (id: string): QueueItem => ({ id, message: id });
const place = (rows: Rows, key: string) => (rows[key] as ItemRow | NodeRow).place;

describe('toRows and fromRows', () => {
  it('keep each entity under a key of its own, its ids escaped: the lesser end of a link first', () => {
    const rows = toRows(everything);
    expect(Object.keys(rows)).toEqual([
      META,
      'node/team',
      'node/lead',
      'node/worker%2F1',
      'node/%C3%9Cn%C3%AFcode%20%F0%9D%94%B8',
      'node/%EF%BF%BD',
      'link/lead/worker%2F1',
      'link/%C3%9Cn%C3%AFcode%20%F0%9D%94%B8/%EF%BF%BD',
      'link/lead/%C3%9Cn%C3%AFcode%20%F0%9D%94%B8',
      ...[
        'spec',
        'check',
        'if-red',
        'fix',
        'tell',
        'joined',
        'later',
        'ok',
        'loop',
        'again',
        'waited',
        'pause',
        'run',
        'if-usage',
      ].map((id) => itemKey('lead', id)),
      'item/worker%2F1/x',
    ]);
    expect(nodeKey('worker/1')).toBe('node/worker%2F1');
    expect(linkKey('b', 'a')).toBe(linkKey('a', 'b'));
    // By code point, as SQLite compares text: U+FFFD before U+1D538, though not as UTF-16 does.
    expect(linkKey('\u{1D538}', '\uFFFD')).toBe('link/%EF%BF%BD/%F0%9D%94%B8');
  });

  it('keep what each row is: a node’s place among them all, a link’s ends and how it was drawn', () => {
    const rows = toRows(everything);
    expect(rows[META]).toEqual({ arrange: true });
    expect(rows['node/worker%2F1']).toEqual({
      id: 'worker/1',
      kind: 'agent',
      parent: 'lead',
      place: 2,
      label: 'Worker',
      x: 0,
      y: 200,
      adapter: 'made-up',
      connection: 'made-up.cli',
      settings: { 'made-up': { mode: 'careful' } },
    });
    expect(rows['node/team']).toEqual({
      id: 'team',
      kind: 'frame',
      place: 0,
      label: 'Team',
      x: -40,
      y: 12.5,
      color: 3,
    });
    expect(rows['link/lead/worker%2F1']).toEqual({
      a: 'lead',
      b: 'worker/1',
      source: 'worker/1',
      dots: ['top', 'bottom'],
      place: 0,
    });
  });

  it('keep an item’s fields but its id and what it holds in its body, in its holder’s order', () => {
    const rows = toRows(everything);
    expect(rows[itemKey('lead', 'if-red')]).toEqual({
      agent: 'lead',
      id: 'if-red',
      place: 2,
      kind: 'if',
      body: { if: { kind: 'outputContains', text: 'RED', wholeLine: true } },
    });
    expect(rows[itemKey('lead', 'tell')]).toEqual({
      agent: 'lead',
      id: 'tell',
      container: 'if-red',
      place: 1,
      kind: 'message',
      body: { message: 'Fix it', target: 'worker/1' },
    });
    expect(rows[itemKey('lead', 'loop')]).toEqual({
      agent: 'lead',
      id: 'loop',
      place: 6,
      kind: 'repeat',
      body: {
        until: { kind: 'repeatEnds', agent: 'Ünïcode 𝔸', item: 'rounds' },
        rounds: 3,
        otherwise: 'ask',
      },
    });
    expect(
      Object.values(rows).flatMap((row) => ('kind' in row && 'body' in row ? [row.kind] : [])),
    ).toEqual([
      'message',
      'step',
      'if',
      'step',
      'message',
      'wait',
      'delay',
      'approval',
      'repeat',
      'message',
      'wait',
      'delay',
      'step',
      'if',
      'step',
    ]);
  });

  it('never keep a live submission’s record, which only a view shows', () => {
    const submitted = queued([
      {
        id: 'sent',
        message: 'Sent by hand',
        submission: { id: 'sent', text: 'Sent by hand', status: 'completed' },
      },
    ]);
    expect((toRows(submitted)[itemKey('a', 'sent')] as ItemRow).body).toEqual({
      message: 'Sent by hand',
    });
  });

  it('read back every shipped template as it was read from its file, and writes it so', () => {
    for (const example of EXAMPLES) {
      const document = fromFile(example.text, TEST_CATALOG, 'claude-code');
      const read = fromRows(document.id, toRows(document));
      expect(read, example.name).toEqual(document);
      expect(toFile(read), example.name).toBe(
        example.text.replace('"version": 2', `"version": ${String(CANVAS_VERSION)}`),
      );
    }
  });

  it('read back a canvas holding everything a canvas may, as its file reads', () => {
    const read = fromRows(ID, toRows(everything));
    expect(read).toEqual(everything);
    expect(toFile(read)).toBe(toFile(everything));
    // Its file holds an adapter no build has: read with a catalog that has it, as written.
    expect(toFile(fromRows(ID, toRows(fromFile(toFile(read), TEST_CATALOG, 'claude-code'))))).toBe(
      toFile(everything),
    );
  });

  it('read rows in their places’ order, whatever order they come in', () => {
    const rows = toRows(everything);
    const shuffled = Object.fromEntries(Object.entries(rows).reverse());
    expect(fromRows(ID, shuffled)).toEqual(everything);
  });

  it('read a node before what it holds, even placed after it', () => {
    const rows = { ...toRows(everything) };
    rows['node/team'] = { ...(rows['node/team'] as NodeRow), place: 10 };
    expect(fromRows(ID, rows).nodes.map((n: CanvasNode) => n.id)).toEqual(
      everything.nodes.map((n) => n.id),
    );
  });

  it('read an agent with no items as one with no queue, as its file does', () => {
    const read = fromRows(ID, toRows(queued([])));
    expect(read.nodes[0]).toEqual({
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'A' },
    });
  });

  it.each<[string, (rows: Record<string, unknown>) => void, RegExp]>([
    [
      'an item of no agent',
      (rows) => {
        rows[itemKey('c', 'x')] = { agent: 'c', id: 'x', place: 0, kind: 'step', body: {} };
      },
      /^item\/c\/x: its agent isn’t there$/,
    ],
    [
      'an item inside no item of its agent’s',
      (rows) => {
        rows[itemKey('a', 'x')] = {
          agent: 'a',
          id: 'x',
          container: 'gone',
          place: 0,
          kind: 'step',
          body: {},
        };
      },
      /^item\/a\/x: what holds it isn’t there$/,
    ],
    [
      'an item inside what holds none',
      (rows) => {
        rows[itemKey('a', 'x')] = {
          agent: 'a',
          id: 'x',
          container: 'one',
          place: 0,
          kind: 'step',
          body: {},
        };
      },
      /^item\/a\/one: a message holds no items$/,
    ],
    [
      'a node inside no node',
      (rows) => {
        rows['node/b'] = { ...(rows['node/b'] as NodeRow), parent: 'gone' };
      },
      /^node\/b: its parent isn’t there$/,
    ],
    [
      'a link to no agent',
      (rows) => {
        rows[linkKey('a', 'gone')] = { a: 'a', b: 'gone', source: 'a', place: 0 };
      },
      /^link\/a\/gone: one of its agents isn’t there$/,
    ],
  ])('refuse rows that hold no canvas: %s', (_label, breakIt, error) => {
    const rows: Record<string, unknown> = { ...toRows(queued([message('one')])) };
    breakIt(rows);
    expect(() => fromRows(ID, rows as Rows)).toThrow(error);
  });
});

describe('rowsFault', () => {
  it('finds nothing in a canvas its rows hold: every shipped template, and everything a canvas may hold', () => {
    for (const example of EXAMPLES) {
      expect(rowsFault(fromFile(example.text, TEST_CATALOG, 'claude-code')), example.name).toBe(
        undefined,
      );
    }
    expect(rowsFault(everything)).toBeUndefined();
  });

  const frame = (id: string, parentId?: string): CanvasNode => ({
    id,
    type: 'frame',
    position: { x: 0, y: 0 },
    ...(parentId === undefined ? {} : { parentId }),
    data: { label: id },
  });
  const [a, b] = queued([]).nodes as [AgentNode, AgentNode];
  it.each<[string, CanvasDocument, string]>([
    [
      'two nodes of one id',
      { ...queued([]), nodes: [a, b, { ...b, data: { label: 'B again' } }] },
      'node/b: two nodes have this id',
    ],
    [
      'a node inside one that isn’t there',
      { ...queued([]), nodes: [a, { ...b, parentId: 'gone' }] },
      'node/b: its parent isn’t there',
    ],
    [
      'a node before the one it is inside',
      { ...queued([]), nodes: [{ ...a, parentId: 'f' }, b, frame('f')] },
      'node/a: it comes before its parent',
    ],
    [
      'a node inside itself',
      { ...queued([]), nodes: [frame('f', 'f'), a, b] },
      'node/f: it comes before its parent',
    ],
    [
      'a link to what is no agent',
      { ...queued([]), nodes: [a, frame('b')], links: [{ source: 'a', target: 'b' }] },
      'link/a/b: one of its agents isn’t there',
    ],
    [
      'a link to an agent that isn’t there',
      { ...queued([]), links: [{ source: 'a', target: 'gone' }] },
      'link/a/gone: one of its agents isn’t there',
    ],
    [
      'a link from an agent to itself',
      { ...queued([]), links: [{ source: 'a', target: 'a' }] },
      'link/a/a: it links an agent to itself',
    ],
    [
      'two links between the same agents',
      {
        ...queued([]),
        links: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'a' },
        ],
      },
      'link/a/b: the agents are linked twice',
    ],
    [
      'two items of one id in a queue, at any depth',
      queued([
        message('one'),
        { id: 'if', if: { kind: 'failed' }, then: [{ id: 'one', message: 'one' }] },
      ]),
      'item/a/one: two items of its queue have this id',
    ],
  ])('finds what keeps a canvas from its rows: %s', (_label, document, fault) => {
    expect(rowsFault(document)).toBe(fault);
  });
});

describe('diffRows', () => {
  const four = queued(['a1', 'a2', 'a3', 'a4'].map(message));
  const keyOf = (id: string) => itemKey('a', id);

  it('changes nothing for the same canvas', () => {
    const rows = toRows(everything);
    expect(diffRows(rows, everything)).toEqual({ rows, changed: [], renumbered: [] });
  });

  it('changes only the item whose text changed, not its agent nor its neighbours', () => {
    const before = toRows(four);
    const { changed, rows } = diffRows(
      before,
      queued([message('a1'), { id: 'a2', message: 'Changed' }, message('a3')]),
    );
    expect(changed).toEqual([keyOf('a2'), keyOf('a4')]);
    expect(rows[keyOf('a4')]).toBeUndefined();
  });

  it('moves one row when an item moves, every other keeping its place', () => {
    const before = toRows(four);
    const { changed, renumbered, rows } = diffRows(
      before,
      queued(['a4', 'a1', 'a2', 'a3'].map(message)),
    );
    expect(changed).toEqual([keyOf('a4')]);
    expect(renumbered).toEqual([]);
    for (const id of ['a1', 'a2', 'a3'])
      expect(place(rows, keyOf(id))).toBe(place(before, keyOf(id)));
    expect(place(rows, keyOf('a4'))).toBeLessThan(place(rows, keyOf('a1')));
  });

  it('puts an item added between two others between their places, moving neither', () => {
    const before = toRows(four);
    const { changed, rows } = diffRows(
      before,
      queued(['a1', 'a2', 'new', 'a3', 'a4'].map(message)),
    );
    expect(changed).toEqual([keyOf('new')]);
    expect(place(rows, keyOf('new'))).toBeGreaterThan(place(before, keyOf('a2')));
    expect(place(rows, keyOf('new'))).toBeLessThan(place(before, keyOf('a3')));
  });

  it('places an item moved into a repeat among what that repeat holds', () => {
    const repeat = (ids: string[]): QueueItem => ({
      id: 'r',
      repeat: ids.map(message) as never,
      until: { kind: 'succeeded' },
      rounds: 2,
      otherwise: 'ask',
    });
    const before = toRows(queued([message('a1'), repeat(['in'])]));
    const { changed, rows } = diffRows(before, queued([repeat(['in', 'a1'])]));
    expect(changed).toEqual([keyOf('a1')]);
    expect(rows[keyOf('a1')]).toMatchObject({ container: 'r' });
    expect(place(rows, keyOf('a1'))).toBeGreaterThan(place(rows, keyOf('in')));
  });

  it('removes what is gone: an agent with its items and its links', () => {
    const linked: CanvasDocument = { ...four, links: [{ source: 'a', target: 'b' }] };
    const before = toRows(linked);
    const next: CanvasDocument = { ...four, nodes: four.nodes.slice(1), links: [] };
    expect(diffRows(before, next).changed.sort()).toEqual(
      ['node/a', linkKey('a', 'b'), ...['a1', 'a2', 'a3', 'a4'].map(keyOf)].sort(),
    );
  });

  it('counts its arrangement, and a node moved on the canvas, as changes of their own', () => {
    const before = toRows(four);
    const [a, b] = four.nodes as [AgentNode, AgentNode];
    const { changed } = diffRows(before, {
      ...four,
      arrange: true,
      nodes: [a, { ...b, position: { x: 310, y: 0 } }],
    });
    expect(changed).toEqual([META, 'node/b']);
  });

  it('renumbers a list whose places ran out, changing no entity but the one added', () => {
    let document = queued([message('zero'), message('first'), message('last')]);
    let rows = toRows(document);
    let renumbered: string[] = [];
    // Each added just after the first, until no number lies between it and the one added last.
    for (let i = 0; i < 80 && renumbered.length === 0; i++) {
      const queue = (document.nodes[0] as AgentNode).data.queue ?? [];
      document = queued([...queue.slice(0, 2), message(`n${String(i)}`), ...queue.slice(2)]);
      const diff = diffRows(rows, document);
      expect(diff.changed).toEqual([keyOf(`n${String(i)}`)]);
      ({ rows, renumbered } = diff);
    }
    expect(renumbered.length).toBeGreaterThan(0);
    const places = ((document.nodes[0] as AgentNode).data.queue ?? []).map((item) =>
      place(rows, keyOf(item.id)),
    );
    expect(places).toEqual([...places].sort((x, y) => x - y));
    expect(new Set(places).size).toBe(places.length);
    expect(fromRows(ID, rows)).toEqual(document);
  });

  it('places links among the canvas’s links as it places nodes', () => {
    const three: CanvasDocument = {
      ...four,
      nodes: [
        ...four.nodes,
        { id: 'c', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'C' } },
      ],
      links: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    };
    const before = toRows(three);
    const { changed, rows } = diffRows(before, { ...three, links: [...three.links].reverse() });
    expect(changed).toHaveLength(1);
    expect((rows[linkKey('b', 'c')] as LinkRow).place).toBeLessThan(
      (rows[linkKey('a', 'b')] as LinkRow).place,
    );
  });
});

describe('diffRows by reference', () => {
  /** `document` with node `id` as `change` makes it, every other node the same object. */
  const withNode = (
    document: CanvasDocument,
    id: string,
    change: (node: CanvasNode) => CanvasNode | undefined,
  ): CanvasDocument => ({
    ...document,
    nodes: document.nodes.flatMap((node) => {
      if (node.id !== id) return [node];
      const changed = change(node);
      return changed === undefined ? [] : [changed];
    }),
  });
  /** `document` with agent `id`'s queue as `change` makes it. */
  const withQueue = (
    document: CanvasDocument,
    id: string,
    change: (queue: readonly QueueItem[]) => QueueItem[] | undefined,
  ): CanvasDocument =>
    withNode(document, id, (node) => {
      if (node.type !== 'agent') return node;
      const { queue, ...data } = node.data;
      const next = change(queue ?? []);
      return { ...node, data: next === undefined ? data : { ...data, queue: next } };
    });

  /** Edits of `everything`, each keeping what it doesn't change the same object. */
  const EDITS: [string, (document: CanvasDocument) => CanvasDocument][] = [
    ['nothing', (document) => document],
    ['nothing, in new lists', (document) => ({ ...document, nodes: [...document.nodes] })],
    [
      'a node renamed',
      (document) =>
        withNode(document, 'lead', (node) => ({ ...node, data: { ...node.data, label: 'Head' } })),
    ],
    [
      'a node replaced by one equal to it',
      (document) => withNode(document, 'team', (node) => structuredClone(node)),
    ],
    [
      'a node moved on the canvas',
      (document) =>
        withNode(document, 'Ünïcode 𝔸', (node) => ({ ...node, position: { x: 1, y: 2 } })),
    ],
    [
      'a node moved into another',
      (document) => withNode(document, 'worker/1', (node) => ({ ...node, parentId: 'team' })),
    ],
    ['its arrangement', (document) => ({ ...document, arrange: !document.arrange })],
    [
      'an agent deleted, with its link',
      (document) => ({
        ...withNode(document, '�', () => undefined),
        links: document.links.filter((link) => link.target !== '�'),
      }),
    ],
    [
      'a link added',
      (document) => ({ ...document, links: [...document.links, { source: '�', target: 'lead' }] }),
    ],
    ['its links reordered', (document) => ({ ...document, links: [...document.links].reverse() })],
    [
      'an agent’s settings',
      (document) =>
        withNode(document, 'lead', (node) =>
          node.type === 'agent'
            ? { ...node, data: { ...node.data, settings: { codex: { model: 'gpt-7' } } } }
            : node,
        ),
    ],
    [
      'an item deep in a repeat changed',
      (document) =>
        withQueue(document, 'lead', (queue) =>
          queue.map((item) =>
            item.id === 'loop' && 'repeat' in item
              ? {
                  ...item,
                  repeat: item.repeat.map((inner) =>
                    inner.id === 'waited' ? { ...inner, timeout: { seconds: 90 } } : inner,
                  ),
                }
              : item,
          ),
        ),
    ],
    [
      'an item moved to the top',
      (document) =>
        withQueue(document, 'lead', (queue) => [
          ...queue.filter((item) => item.id === 'later'),
          ...queue.filter((item) => item.id !== 'later'),
        ]),
    ],
    [
      'an item moved out of an if-then',
      (document) =>
        withQueue(document, 'lead', (queue) => {
          const red = queue.find((item) => item.id === 'if-red');
          const fix = red && 'then' in red ? red.then.find((item) => item.id === 'fix') : undefined;
          return [
            ...(fix ? [fix] : []),
            ...queue.map((item) =>
              item === red && 'then' in item
                ? { ...item, then: item.then.filter((inner) => inner !== fix) }
                : item,
            ),
          ];
        }),
    ],
    [
      'an item added between two',
      (document) =>
        withQueue(document, 'lead', (queue) => [
          ...queue.slice(0, 1),
          message('new'),
          ...queue.slice(1),
        ]),
    ],
    [
      'an item removed',
      (document) =>
        withQueue(document, 'lead', (queue) => queue.filter((item) => item.id !== 'ok')),
    ],
    [
      'an item moved to another agent',
      (document) =>
        withQueue(
          withQueue(document, 'worker/1', () => undefined),
          'lead',
          (queue) => [...queue, { id: 'x', action: 'Read' }],
        ),
    ],
    ['a queue emptied', (document) => withQueue(document, 'lead', () => undefined)],
  ];

  it.each(EDITS)('diffs %s as it would by value', (_edit, edit) => {
    const before = toRows(everything);
    const next = edit(everything);
    const byValue = diffRows(before, next);
    const byReference = diffRows(before, next, everything);
    expect(byReference).toEqual(byValue);
    // Rows are written in their order: a node after what holds it, an item after its holder.
    expect(Object.keys(byReference.rows)).toEqual(Object.keys(byValue.rows));
    expect(fromRows(ID, byReference.rows)).toEqual(next);
  });

  it('diffs every shipped template’s edits as it would by value', () => {
    for (const example of EXAMPLES) {
      const document = fromFile(example.text, TEST_CATALOG, 'claude-code');
      const before = toRows(document);
      const [first] = document.nodes;
      const agent = document.nodes.find((node) =>
        node.type === 'agent' ? node.data.queue : false,
      );
      const edits = [
        first && withNode(document, first.id, (node) => ({ ...node, position: { x: 7, y: 7 } })),
        agent &&
          withQueue(document, agent.id, (queue) => [...queue.slice(1), ...queue.slice(0, 1)]),
        { ...document, nodes: document.nodes.slice(0, -1), links: [] },
      ];
      for (const next of edits) {
        if (next === undefined) continue;
        const byReference = diffRows(before, next, document);
        expect(byReference, example.name).toEqual(diffRows(before, next));
        expect(Object.keys(byReference.rows)).toEqual(Object.keys(diffRows(before, next).rows));
      }
    }
  });

  it('renumbers a list whose places ran out as it would by value', () => {
    let document = queued([message('zero'), message('first'), message('last')]);
    let rows = toRows(document);
    let renumbered = 0;
    for (let i = 0; i < 80 && renumbered === 0; i++) {
      const next = withQueue(document, 'a', (queue) => [
        ...queue.slice(0, 2),
        message(`n${String(i)}`),
        ...queue.slice(2),
      ]);
      const diff = diffRows(rows, next, document);
      expect(diff).toEqual(diffRows(rows, next));
      ({ rows } = diff);
      renumbered = diff.renumbered.length;
      document = next;
    }
    expect(renumbered).toBeGreaterThan(0);
  });

  it('reads no more of what is unchanged than its keys', () => {
    const before = toRows(everything);
    // The worker's node is shared: reading its settings or its queue's items' bodies would throw.
    const worker = everything.nodes.find((node) => node.id === 'worker/1') as AgentNode;
    const guarded: AgentNode = {
      ...worker,
      data: {
        ...worker.data,
        get settings(): never {
          throw new Error('Read a shared node’s settings.');
        },
      },
    };
    const was = withNode(everything, 'worker/1', () => guarded);
    const wasRows = { ...before };
    const next = withNode(was, 'lead', (node) => ({ ...node, position: { x: 0, y: 0 } }));
    expect(diffRows(wasRows, next, was).changed).toEqual([nodeKey('lead')]);
  });
});
