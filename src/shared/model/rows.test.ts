import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import { TEST_CATALOG } from '../engine/test-engine';
import { EXAMPLES } from '../examples';
import type { AgentNode, CanvasDocument, CanvasNode } from './canvas';
import { fromFile, toFile } from './file';
import type { QueueItem } from './queue';
import { diffRows, fromRows, itemKey, linkKey, META, nodeKey, toRows } from './rows';
import type { ItemRow, LinkRow, NodeRow, Rows } from './rows';

/*
 * A canvas's document as the rows the core keeps it in (B9 Design §2) and its topics carry: one row
 * an entity, by key, read back by the same function wherever it is read.
 */

const ID = '3f1b0d6e-8c2a-4e7f-9b5d-1a2c3e4f5a6b' as CanvasId;

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
    { id: 'Ünïcode 𝔸', type: 'agent', position: { x: 600, y: 0 }, data: { label: '' } },
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
      expect(toFile(read), example.name).toBe(example.text);
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
