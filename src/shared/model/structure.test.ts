import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import type { AgentData, CanvasDocument, CanvasNode, Link, Position } from './canvas';
import {
  addAgent,
  addParent,
  canLink,
  canUngroup,
  group,
  groupMembers,
  link,
  move,
  nextLabel,
  NODE_GAP,
  RANK_GAP,
  remove,
  rename,
  spawnAgent,
  ungroup,
  unlink,
} from './structure';
import type { StructureContext } from './structure';
import {
  absolutePosition,
  autosize,
  CARD_SIZE,
  EMPTY_FRAME,
  GROUP_COLORS,
  PADDING,
  size,
  topInset,
} from './geometry';
import { areLinked } from './queries';
import { fromFile, toFile } from './file';
import { TEST_CATALOG } from '../engine/test-engine';

const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId;
const doc = (): CanvasDocument => ({
  id: ID,
  arrange: true,
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Builder', queue: [{ id: 'task', action: 'Read' }] },
    },
    {
      id: 'b',
      type: 'agent',
      position: { x: 300, y: 0 },
      data: { label: 'Reviewer', queue: [{ id: 'wait', waitFor: [{ agent: 'a', item: 'task' }] }] },
    },
    { id: 'c', type: 'agent', position: { x: 600, y: 0 }, data: { label: 'Untouched' } },
  ],
  links: [{ source: 'b', target: 'c' }],
});

describe('canvas structure operations', () => {
  it('keeps unchanged nodes, positions, queues and links identical, including no-op documents', () => {
    const before = doc();
    const changed = rename(before, { id: 'a', label: 'Edited' });
    expect(changed.next).not.toBe(before);
    expect(changed.next.id).toBe(before.id);
    expect(changed.next.arrange).toBe(true);
    expect(changed.next.nodes[0]?.position).toBe(before.nodes[0]?.position);
    expect(get(changed.next, 'a').data.queue).toBe(get(before, 'a').data.queue);
    expect(changed.next.nodes[1]).toBe(before.nodes[1]);
    expect(changed.next.nodes[2]).toBe(before.nodes[2]);
    expect(changed.next.links).toBe(before.links);
    expect(rename(changed.next, { id: 'a', label: 'Edited' }).next).toBe(changed.next);
  });

  it('returns the words for references cleared by deleting explicit ids', () => {
    const before = doc();
    const changed = remove(before, { nodes: ['a'] });
    expect(changed.result.cleared).toEqual(['Reviewer’s wait 1 for Builder’s step 1 was removed.']);
    expect(changed.next.nodes.map((node) => node.id)).toEqual(['b', 'c']);
    expect(get(changed.next, 'b').data.queue).toEqual([]);
    expect(changed.next.nodes[1]).toBe(before.nodes[2]);
    expect(changed.next.links).toBe(before.links);
  });

  it('uses the supplied id function for the new agent and its initial message, returning a selection hint', () => {
    const before = doc();
    const ids = ['new-agent', 'new-message'];
    const changed = addAgent(
      before,
      { at: { x: 1000, y: 500 }, adapter: 'codex' },
      {
        defaultAdapter: 'claude-code',
        newId: () => ids.shift() ?? 'unexpected',
      },
    );
    expect(changed.result).toEqual({ id: 'new-agent', select: ['new-agent'] });
    expect(changed.next.nodes[3]?.data).toEqual({
      label: 'Agent 1',
      adapter: 'codex',
      queue: [{ id: 'new-message', message: '' }],
    });
    expect(changed.next.nodes[0]).toBe(before.nodes[0]);
    expect(changed.next.nodes[1]).toBe(before.nodes[1]);
    expect(changed.next.links).toBe(before.links);
    expect(ids).toEqual([]);
  });
});

const context = (id: string): StructureContext => {
  const ids = [id, `${id}/message`];
  return { defaultAdapter: 'claude-code', newId: () => ids.shift() ?? 'unexpected-id' };
};
const agent = (id: string, x = 0, y = 0, data: Partial<AgentData> = {}): CanvasNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id, ...data },
});
const frame = (id: string, x = 0, y = 0): CanvasNode => ({
  id,
  type: 'frame',
  position: { x, y },
  data: { label: id },
});
const inside = (parentId: string, node: CanvasNode): CanvasNode => ({ ...node, parentId });
function frozen(nodes: CanvasNode[], links: Link[] = []): CanvasDocument {
  const document: CanvasDocument = { id: ID, arrange: false, nodes, links };
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(document);
  return document;
}
function get(doc: CanvasDocument, id: string): CanvasNode & { data: AgentData } {
  const node = doc.nodes.find((node) => node.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}
function abs(doc: CanvasDocument, id: string): Position {
  return absolutePosition(get(doc, id), new Map(doc.nodes.map((node) => [node.id, node])));
}
const positions = (doc: CanvasDocument, ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, abs(doc, id)]));
function box(doc: CanvasDocument, id: string) {
  const fitted = autosize(doc.nodes);
  const node = fitted.find((node) => node.id === id);
  if (!node) throw new Error(`no box ${id}`);
  return {
    ...absolutePosition(node, new Map(fitted.map((node) => [node.id, node]))),
    ...size(node),
  };
}
function grouped(id = 'G', kind: CanvasNode['type'] = 'frame'): CanvasDocument {
  return group(
    frozen([agent('a', 100, 100), agent('b', 300, 200)]),
    { kind, nodes: ['a', 'b'] },
    context(id),
  ).next;
}
function expectValid(doc: CanvasDocument) {
  const indices = new Map(doc.nodes.map((node, i) => [node.id, i]));
  for (const [i, node] of doc.nodes.entries()) {
    if (node.parentId !== undefined) expect(indices.get(node.parentId)).toBeLessThan(i);
    expect(node).not.toHaveProperty('width');
    expect(node).not.toHaveProperty('height');
  }
  const fitted = autosize(doc.nodes);
  for (const node of fitted) {
    const children = fitted.filter((child) => child.parentId === node.id);
    if (!children.length) continue;
    expect(Math.min(...children.map((child) => child.position.x))).toBe(PADDING);
    expect(Math.min(...children.map((child) => child.position.y))).toBe(topInset(node.type));
    expect(node.position).toEqual(get(doc, node.id).position);
  }
}

describe('nextLabel', () => {
  it('numbers past the largest existing label with the prefix', () => {
    expect(nextLabel([], 'Agent')).toBe('Agent 1');
    const nodes = ['Agent 2', 'Agent 7', 'Agent 9a', 'Group 12', 'Alpha'].map((label, i) =>
      agent(String(i), 0, 0, { label }),
    );
    expect(nextLabel(nodes, 'Agent')).toBe('Agent 8');
    expect(nextLabel(nodes, 'Group')).toBe('Group 13');
  });
});

describe('addAgent', () => {
  it('adds an agent centred on the point and returns only its id as the selection hint', () => {
    const before = frozen([agent('a')]);
    const changed = addAgent(before, { at: { x: 200, y: 100 }, adapter: 'codex' }, context('n'));
    expect(get(changed.next, 'n')).toEqual({
      id: 'n',
      type: 'agent',
      position: { x: 125, y: 83 },
      data: {
        label: 'Agent 1',
        adapter: 'codex',
        queue: [{ id: 'n/message', message: '' }],
      },
    });
    expect(changed.result).toEqual({ id: 'n', select: ['n'] });
    expect(changed.next.nodes[0]).toBe(before.nodes[0]);
  });
  it('nudges nodes that would land on the corner of another', () => {
    let doc = frozen([]);
    for (const id of ['a', 'b', 'c'])
      doc = addAgent(doc, { at: { x: 200, y: 100 }, adapter: 'codex' }, context(id)).next;
    expect(doc.nodes.map((node) => node.position)).toEqual([
      { x: 125, y: 83 },
      { x: 149, y: 107 },
      { x: 173, y: 131 },
    ]);
  });
  it('adds into the innermost container and grows it without moving its other agents', () => {
    const first = group(
      frozen([agent('a', 140, 204)]),
      { kind: 'frame', nodes: ['a'] },
      context('inner'),
    ).next;
    const before = group(first, { kind: 'frame', nodes: ['inner'] }, context('outer')).next;
    const point = abs(before, 'a');
    const changed = addAgent(
      before,
      { at: { x: point.x + 100, y: point.y + 20 }, adapter: 'codex' },
      context('n'),
    ).next;
    expect(get(changed, 'n').parentId).toBe('inner');
    expect(abs(changed, 'a')).toEqual(abs(before, 'a'));
    expectValid(changed);
  });
  it('grows a container left and up past its padding, moving nothing else', () => {
    const before = group(
      frozen([agent('a', 100, 100)]),
      { kind: 'frame', nodes: ['a'] },
      context('G'),
    ).next;
    const origin = abs(before, 'G');
    const changed = addAgent(
      before,
      { at: { x: origin.x + 5, y: origin.y + 60 }, adapter: 'codex' },
      context('n'),
    ).next;
    expect(get(changed, 'n').parentId).toBe('G');
    expect(abs(changed, 'G').x).toBeLessThan(origin.x);
    expect(abs(changed, 'a')).toEqual(abs(before, 'a'));
    expectValid(changed);
  });
});

describe('spawnAgent', () => {
  it('puts a peer beside its source, keeps its adapter and selects it alone', () => {
    const before = frozen([agent('a', 0, 0, { adapter: 'codex' })]);
    const one = spawnAgent(before, { from: 'a', relation: 'peer' }, context('n'));
    expect(get(one.next, 'n').position).toEqual({ x: CARD_SIZE.width + NODE_GAP, y: 0 });
    expect(get(one.next, 'n').data.adapter).toBe('codex');
    expect(one.result.select).toEqual(['n']);
    expect(one.next.links).toBe(before.links);
    const two = spawnAgent(one.next, { from: 'a', relation: 'peer' }, context('m')).next;
    expect(get(two, 'm').position).toEqual({ x: 2 * (CARD_SIZE.width + NODE_GAP), y: 0 });
  });
  it('puts a linked agent below its source, linked between the same dots as a drawn link', () => {
    const one = spawnAgent(
      frozen([agent('a')]),
      { from: 'a', relation: 'linked' },
      context('n'),
    ).next;
    expect(get(one, 'n').position).toEqual({ x: 0, y: CARD_SIZE.height + RANK_GAP });
    expect(one.links).toEqual([{ source: 'a', target: 'n', dots: ['bottom', 'top'] }]);
    const two = spawnAgent(one, { from: 'a', relation: 'linked' }, context('m')).next;
    expect(get(two, 'm').position).toEqual({
      x: CARD_SIZE.width + NODE_GAP,
      y: CARD_SIZE.height + RANK_GAP,
    });
  });
  it('steps past cards and groups in its row, leaving a clear row alone', () => {
    const before = frozen([
      agent('a'),
      agent('b', CARD_SIZE.width + NODE_GAP, 10),
      frame('F', 400, -20),
      agent('c', 800, 500),
    ]);
    const changed = spawnAgent(before, { from: 'a', relation: 'peer' }, context('n')).next;
    expect(abs(changed, 'n')).toEqual({ x: 400 + EMPTY_FRAME.width + NODE_GAP, y: 0 });
  });
  it('stays in its source group, which grows while keeping all other agents in place', () => {
    const before = group(
      frozen([agent('a', 100, 100)]),
      { kind: 'frame', nodes: ['a'] },
      context('G'),
    ).next;
    for (const relation of ['peer', 'linked'] as const) {
      const changed = spawnAgent(before, { from: 'a', relation }, context('n')).next;
      expect(get(changed, 'n').parentId).toBe('G');
      expect(positions(changed, ['a'])).toEqual(positions(before, ['a']));
      expectValid(changed);
    }
  });
  it('copies startup connection, settings and role, with a fresh queue', () => {
    const settings = { codex: { model: 'model', effort: 'low' } };
    const before = frozen([
      agent('a', 0, 0, {
        adapter: 'codex',
        connection: 'codex.terminal',
        settings,
        role: 'Reviews',
        queue: [{ id: 'old', message: 'Old' }],
      }),
    ]);
    const changed = spawnAgent(before, { from: 'a', relation: 'peer' }, context('n')).next;
    expect(get(changed, 'n').data).toMatchObject({
      adapter: 'codex',
      connection: 'codex.terminal',
      settings,
      role: 'Reviews',
      queue: [{ id: 'n/message', message: '' }],
    });
    expect(get(changed, 'n').data.settings).toBe(settings);
    const plain = spawnAgent(
      frozen([agent('a')]),
      { from: 'a', relation: 'peer' },
      context('n'),
    ).next;
    expect(get(plain, 'n').data).not.toHaveProperty('connection');
    expect(get(plain, 'n').data).not.toHaveProperty('role');
  });
  it('does nothing when the source is a frame or missing, minting no ids', () => {
    const before = frozen([frame('F')]);
    for (const from of ['F', 'missing']) {
      const changed = spawnAgent(
        before,
        { from, relation: 'peer' },
        {
          defaultAdapter: 'codex',
          newId: () => {
            throw new Error('must not mint');
          },
        },
      );
      expect(changed.next).toBe(before);
    }
  });
});

describe('rename', () => {
  it('renames agents and frames, accepting an empty label', () => {
    const before = frozen([agent('a'), frame('F')]);
    expect(get(rename(before, { id: 'a', label: 'Alpha' }).next, 'a').data.label).toBe('Alpha');
    expect(get(rename(before, { id: 'F', label: '' }).next, 'F').data.label).toBe('');
  });
  it('returns the same document for an unchanged label or missing node', () => {
    const before = frozen([agent('a')]);
    expect(rename(before, { id: 'a', label: 'a' }).next).toBe(before);
    expect(rename(before, { id: 'missing', label: 'a' }).next).toBe(before);
  });
});

describe('links', () => {
  it('links agents between the dots it was drawn between, with no direction', () => {
    const before = frozen([agent('a'), agent('b'), frame('F'), inside('F', agent('c', 20, 52))]);
    const changed = link(before, { source: 'a', target: 'b', dots: ['bottom', 'top'] }).next;
    expect(changed.links).toEqual([{ source: 'a', target: 'b', dots: ['bottom', 'top'] }]);
    expect(areLinked(changed.links, 'b', 'a')).toBe(true);
    expect(canLink(before, { source: 'a', target: 'c' })).toBe(true);
    expect(changed.nodes).toBe(before.nodes);
  });
  it('links once, whichever way round, while still allowing work to be drawn between them', () => {
    const before = link(frozen([agent('a'), agent('b')]), { source: 'a', target: 'b' }).next;
    expect(link(before, { source: 'a', target: 'b' }).next).toBe(before);
    expect(link(before, { source: 'b', target: 'a' }).next).toBe(before);
    expect(canLink(before, { source: 'b', target: 'a' })).toBe(true);
  });
  it('rejects self loops, frames and missing agents', () => {
    const before = frozen([agent('a'), frame('F')]);
    for (const [source, target] of [
      ['a', 'a'],
      ['a', 'F'],
      ['F', 'a'],
      ['a', 'missing'],
    ]) {
      if (!source || !target) throw new Error('missing ends');
      expect(canLink(before, { source, target })).toBe(false);
      expect(link(before, { source, target }).next).toBe(before);
    }
  });
  it('unlinks only the named link and leaves a missing one alone', () => {
    const before = frozen(
      [agent('a'), agent('b'), agent('c')],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    );
    const changed = unlink(before, { source: 'b', target: 'a' }).next;
    expect(changed.links).toEqual([{ source: 'b', target: 'c' }]);
    expect(changed.links[0]).toBe(before.links[1]);
    expect(changed.nodes).toBe(before.nodes);
    expect(unlink(before, { source: 'a', target: 'c' }).next).toBe(before);
  });
});

describe('remove', () => {
  it('clears references at every depth and leaves a file that reads back', () => {
    const before = frozen([
      agent('builder'),
      agent('reviewer', 0, 100, {
        queue: [
          { id: 'wait', waitFor: [{ agent: 'builder' }] },
          { id: 'send', message: 'Review', target: 'builder' },
          {
            id: 'branch',
            if: { kind: 'freeText', text: 'Ready?' },
            then: [{ id: 'read', action: 'Read', target: 'builder' }],
          },
          {
            id: 'loop',
            repeat: [{ id: 'step', action: 'Read', target: 'builder' }],
            until: { kind: 'repeatEnds', agent: 'builder', item: 'building' },
            rounds: 3,
            otherwise: 'ask',
          },
        ],
      }),
    ]);
    const changed = remove(before, { nodes: ['builder'] });
    expect(get(changed.next, 'reviewer').data.queue).toEqual([
      {
        id: 'branch',
        if: { kind: 'freeText', text: 'Ready?' },
        then: [{ id: 'read', action: 'Read' }],
      },
      { id: 'step', action: 'Read' },
    ]);
    expect(changed.result.cleared.length).toBeGreaterThan(0);
    expect(fromFile(toFile(changed.next), TEST_CATALOG, 'claude-code')).toEqual(changed.next);
  });
  it('deletes explicit nodes and links, including links attached to removed agents', () => {
    const before = frozen(
      [agent('a'), agent('b'), agent('c')],
      [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'a' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'b' },
      ],
    );
    const changed = remove(before, { nodes: ['a'], links: [{ source: 'b', target: 'c' }] }).next;
    expect(changed.nodes.map((node) => node.id)).toEqual(['b', 'c']);
    expect(changed.links).toEqual([{ source: 'c', target: 'b' }]);
  });
  it('does nothing when no existing entity is named', () => {
    const before = frozen([agent('a')]);
    expect(remove(before, {}).next).toBe(before);
    expect(remove(before, { nodes: ['missing'] }).next).toBe(before);
  });
  it('keeps children of deleted containers in their nearest surviving ancestor', () => {
    const before = frozen([
      frame('P', 10, 10),
      inside('P', frame('F', 20, 52)),
      inside('F', frame('G', 20, 52)),
      inside('G', agent('a', 20, 52)),
    ]);
    const changed = remove(before, { nodes: ['F', 'G'] }).next;
    expect(changed.nodes.map((node) => node.id)).toEqual(['P', 'a']);
    expect(get(changed, 'a').parentId).toBe('P');
    expect(abs(changed, 'a')).toEqual(abs(before, 'a'));
    expectValid(changed);
  });
  it('shrinks surviving groups and an emptied frame to its smallest box', () => {
    const before = grouped();
    const changed = remove(before, { nodes: ['b'] }).next;
    expect(box(changed, 'G').width).toBe(CARD_SIZE.width + 2 * PADDING);
    const empty = remove(changed, { nodes: ['a'] }).next;
    expect(size(get({ ...empty, nodes: autosize(empty.nodes) }, 'G'))).toEqual(EMPTY_FRAME);
    expectValid(changed);
  });
  it('moves children of a deleted top-level frame to the top level', () => {
    const before = frozen([frame('F', 100, 100), inside('F', agent('a', 20, 52))]);
    const changed = remove(before, { nodes: ['F'] }).next;
    expect(changed.nodes).toEqual([agent('a', 120, 152)]);
  });
  it('turns a childless parent into its card where that card was centred, keeping links', () => {
    const before = grouped('P', 'agent');
    const oldBox = box(before, 'P');
    const changed = remove(before, { nodes: ['a', 'b'] }).next;
    expect(get(changed, 'P').position).toEqual({
      x: oldBox.x + (oldBox.width - CARD_SIZE.width) / 2,
      y: oldBox.y,
    });
    expectValid(changed);
  });
});

describe('group members', () => {
  it('accepts a single named node and no implicit selection', () => {
    expect(groupMembers([agent('a')], [])).toEqual([]);
    expect(groupMembers([agent('a')], ['a']).map((node) => node.id)).toEqual(['a']);
  });
  it('drops descendants whose ancestor is also named', () => {
    const nodes = [
      frame('F'),
      inside('F', frame('G', 20, 52)),
      inside('G', agent('a', 20, 52)),
      agent('b', 400, 0),
    ];
    expect(groupMembers(nodes, ['F', 'G', 'a', 'b']).map((node) => node.id)).toEqual(['F', 'b']);
  });
  it('rejects members in different containers', () => {
    const nodes = [frame('F'), inside('F', agent('a', 20, 52)), agent('b', 400, 0)];
    expect(groupMembers(nodes, ['a', 'b'])).toEqual([]);
  });
});

describe('group', () => {
  it('frames top-level nodes without moving them, preserving all other entities', () => {
    const before = frozen(
      [agent('x', 900, 900), agent('a', 100, 100), agent('b', 300, 200)],
      [{ source: 'a', target: 'b' }],
    );
    const changed = group(before, { kind: 'frame', nodes: ['a', 'b'] }, context('F'));
    expect(changed.result).toEqual({ id: 'F', select: ['F'] });
    expect(changed.next.nodes.map((node) => node.id)).toEqual(['F', 'x', 'a', 'b']);
    expect(get(changed.next, 'F').position).toEqual({ x: 80, y: 48 });
    expect(positions(changed.next, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
    expect(get(changed.next, 'x')).toBe(before.nodes[0]);
    expect(changed.next.links).toBe(before.links);
    expectValid(changed.next);
  });
  it('creates an agent parent with a new empty queue and the next label', () => {
    const before = frozen([
      agent('a', 0, 0, { label: 'Agent 1' }),
      agent('b', 0, 100, { label: 'Agent 2' }),
    ]);
    const changed = group(before, { kind: 'agent', nodes: ['a', 'b'] }, context('P')).next;
    expect(get(changed, 'P').data).toEqual({
      label: 'Agent 3',
      color: 0,
      adapter: 'claude-code',
      queue: [{ id: 'P/message', message: '' }],
    });
    expect(get(changed, 'P').position).toEqual({ x: -20, y: -topInset('agent') });
    expect(positions(changed, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
    expectValid(changed);
  });
  it('groups one named node', () => {
    const changed = group(frozen([agent('a')]), { kind: 'frame', nodes: ['a'] }, context('F')).next;
    expect(get(changed, 'a').parentId).toBe('F');
  });
  it('nests the new group in its shared parent, growing it without moving its members', () => {
    const before = grouped();
    const changed = group(before, { kind: 'agent', nodes: ['a', 'b'] }, context('N')).next;
    expect(changed.nodes.map((node) => node.id)).toEqual(['G', 'N', 'a', 'b']);
    expect(get(changed, 'N').parentId).toBe('G');
    expect(positions(changed, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
    expectValid(changed);
  });
  it('moves a named container with its contents, including a named descendant', () => {
    const before = grouped('F');
    const changed = group(before, { kind: 'frame', nodes: ['F', 'a'] }, context('G')).next;
    expect(get(changed, 'F').parentId).toBe('G');
    expect(get(changed, 'a').parentId).toBe('F');
    expect(positions(changed, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
  });
  it('does nothing for empty or incompatible members without minting ids', () => {
    const before = frozen([frame('F'), inside('F', agent('a', 20, 52)), agent('b', 400, 0)]);
    for (const nodes of [[], ['a', 'b']])
      expect(
        group(
          before,
          { kind: 'frame', nodes },
          {
            defaultAdapter: 'codex',
            newId: () => {
              throw new Error('must not mint');
            },
          },
        ).next,
      ).toBe(before);
  });
});

describe('addParent', () => {
  it('centres the card where an empty frame was', () => {
    const before = frozen([frame('F', 100, 200)]);
    const changed = addParent(before, { id: 'F' }, context('message')).next;
    expect(get(changed, 'F').position).toEqual({
      x: 100 + (EMPTY_FRAME.width - CARD_SIZE.width) / 2,
      y: 200,
    });
  });
  it('turns a frame into an agent parent without moving its children and selects the parent', () => {
    const before = grouped('F');
    const changed = addParent(before, { id: 'F' }, context('F/message'));
    expect(get(changed.next, 'F').data).toEqual({
      label: 'Agent 1',
      color: 0,
      adapter: 'claude-code',
      queue: [{ id: 'F/message', message: '' }],
    });
    expect(changed.result.select).toEqual(['F']);
    expect(positions(changed.next, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
    expectValid(changed.next);
  });
  it('keeps the old top border in place, with half the card above it', () => {
    const before = grouped('F');
    const changed = addParent(before, { id: 'F' }, context('message')).next;
    expect(get(changed, 'F').position.y + CARD_SIZE.height / 2).toBe(get(before, 'F').position.y);
  });
  it('does nothing for anything but a frame', () => {
    const before = frozen([agent('a')]);
    expect(addParent(before, { id: 'a' }, context('unused')).next).toBe(before);
    expect(addParent(before, { id: 'missing' }, context('unused')).next).toBe(before);
  });
});

describe('group colours', () => {
  it('reuses the least used colour after a group is deleted', () => {
    const one = group(
      frozen([agent('a'), agent('b', 0, 100)]),
      { kind: 'frame', nodes: ['a', 'b'] },
      context('F'),
    ).next;
    const two = group(
      { ...one, nodes: [...one.nodes, agent('c', 400, 0), agent('d', 400, 100)] },
      { kind: 'frame', nodes: ['c', 'd'] },
      context('G'),
    ).next;
    expect(get(one, 'F').data.color).toBe(0);
    expect(get(two, 'G').data.color).toBe(1);
    const removed = remove(two, { nodes: ['F'] }).next;
    const three = group(removed, { kind: 'frame', nodes: ['a', 'b'] }, context('H')).next;
    expect(get(three, 'H').data.color).toBe(0);
  });
  it('cycles through the palette once each colour is taken', () => {
    let doc = frozen([]);
    for (let i = 0; i <= GROUP_COLORS; i++) {
      const ids = [`a${String(i)}`, `b${String(i)}`];
      doc = group(
        {
          ...doc,
          nodes: [...doc.nodes, agent(ids[0] ?? '', i * 400, 0), agent(ids[1] ?? '', i * 400, 100)],
        },
        { kind: 'frame', nodes: ids },
        context(`G${String(i)}`),
      ).next;
    }
    expect(get(doc, `G${String(GROUP_COLORS)}`).data.color).toBe(0);
  });
  it('keeps the colour when a frame gets a parent agent', () => {
    const before = grouped();
    expect(get(addParent(before, { id: 'G' }, context('message')).next, 'G').data.color).toBe(
      get(before, 'G').data.color,
    );
  });
});

describe('ungroup', () => {
  it('removes a frame and returns its children as the selection hint, keeping them in place', () => {
    const before = grouped();
    const changed = ungroup(before, { nodes: ['G'] });
    expect(changed.result.select).toEqual(['a', 'b']);
    expect(changed.next.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(positions(changed.next, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
  });
  it('keeps an agent parent and its links, turning it back into its plain card', () => {
    const before = grouped('P', 'agent');
    const oldBox = box(before, 'P');
    const changed = ungroup(before, { nodes: ['P'] }).next;
    expect(get(changed, 'P').position.x).toBe(oldBox.x + (oldBox.width - CARD_SIZE.width) / 2);
    expect(get(changed, 'a').parentId).toBeUndefined();
    expect(changed.links).toBe(before.links);
    expectValid(changed);
  });
  it('moves children of a nested frame into the outer group', () => {
    const before = group(grouped('F'), { kind: 'frame', nodes: ['F'] }, context('outer')).next;
    const changed = ungroup(before, { nodes: ['F'] }).next;
    expect(changed.nodes.map((node) => node.id)).toEqual(['outer', 'a', 'b']);
    expect(get(changed, 'a').parentId).toBe('outer');
    expect(positions(changed, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
    expectValid(changed);
  });
  it('ungroups only the outermost named container', () => {
    const before = group(grouped('F'), { kind: 'frame', nodes: ['F'] }, context('outer')).next;
    const changed = ungroup(before, { nodes: ['outer', 'F'] }).next;
    expect(changed.nodes.map((node) => node.id)).toEqual(['F', 'a', 'b']);
    expect(get(changed, 'a').parentId).toBe('F');
    expect(positions(changed, ['a', 'b'])).toEqual(positions(before, ['a', 'b']));
  });
  it('moves a named child out one level', () => {
    const before = grouped();
    const changed = ungroup(before, { nodes: ['a'] }).next;
    expect(get(changed, 'a').parentId).toBeUndefined();
    expect(get(changed, 'b').parentId).toBe('G');
    expect(abs(changed, 'a')).toEqual(abs(before, 'a'));
    expectValid(changed);
  });
  it('shrinks a parent whose last child moves out', () => {
    const before = group(frozen([agent('a')]), { kind: 'agent', nodes: ['a'] }, context('P')).next;
    const changed = ungroup(before, { nodes: ['a'] }).next;
    expect(get(changed, 'a').parentId).toBeUndefined();
    expectValid(changed);
  });
  it('removes an empty frame', () => {
    expect(ungroup(frozen([frame('F')]), { nodes: ['F'] }).next.nodes).toEqual([]);
  });
  it('does nothing for a top-level agent', () => {
    const before = frozen([agent('a')]);
    expect(canUngroup(before.nodes, ['a'])).toBe(false);
    expect(ungroup(before, { nodes: ['a'] }).next).toBe(before);
  });
});

describe('move', () => {
  it('moves explicit nodes at once, keeping other objects and all document metadata identical', () => {
    const before = frozen(
      [agent('a'), agent('b', 300, 0), agent('c', 600, 0)],
      [{ source: 'a', target: 'b' }],
    );
    const changed = move(before, {
      moves: [
        { node: 'a', position: { x: 20, y: 30 } },
        { node: 'b', position: { x: 400, y: 50 } },
      ],
    }).next;
    expect(get(changed, 'a').position).toEqual({ x: 20, y: 30 });
    expect(get(changed, 'b').position).toEqual({ x: 400, y: 50 });
    expect(get(changed, 'c')).toBe(before.nodes[2]);
    expect(changed.links).toBe(before.links);
    expect(changed.id).toBe(before.id);
  });
  it('fits nested groups after moving a child, without shifting any other agent on canvas', () => {
    const before = group(
      grouped('inner'),
      { kind: 'frame', nodes: ['inner'] },
      context('outer'),
    ).next;
    const changed = move(before, { moves: [{ node: 'a', position: { x: -60, y: 300 } }] }).next;
    expect(abs(changed, 'b')).toEqual(abs(before, 'b'));
    expectValid(changed);
  });
  it('returns the same document when positions are unchanged or ids are missing', () => {
    const before = frozen([agent('a')]);
    expect(move(before, { moves: [{ node: 'a', position: { x: 0, y: 0 } }] }).next).toBe(before);
    expect(move(before, { moves: [{ node: 'missing', position: { x: 1, y: 2 } }] }).next).toBe(
      before,
    );
  });
});
