import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { diffRows, itemKey, linkKey, nodeKey, toRows } from '../../../shared/model/rows';
import { changeSetOf } from './change';

/*
 * What a commit changes, as the change rules read it (B9 Design §4): each entity it touched, as it
 * was and is, with its revision before; the agents it created and removed, and whose manager it
 * changed; and whether an agent existed before it.
 */

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;

/** A lead heading a crew frame that holds a worker; a peer at the top; the lead linked to it. */
const BEFORE: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [
    { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Lead' } },
    { id: 'crew', type: 'frame', parentId: 'lead', position: { x: 0, y: 0 }, data: { label: 'C' } },
    {
      id: 'worker',
      type: 'agent',
      parentId: 'crew',
      position: { x: 0, y: 0 },
      data: { label: 'Worker', queue: [{ id: 'ok', approve: 'the plan' }] },
    },
    { id: 'peer', type: 'agent', position: { x: 300, y: 0 }, data: { label: 'Peer' } },
  ],
  links: [{ source: 'lead', target: 'peer' }],
};

/** What `next` changes of BEFORE, kept at revision 4, by an outside orchestrator's op. */
function changeTo(next: CanvasDocument, copies?: ReadonlyMap<string, string>) {
  const rows = toRows(BEFORE);
  const live = { document: BEFORE, rows, revs: new Map(Object.keys(rows).map((key) => [key, 4])) };
  return changeSetOf(
    live,
    next,
    diffRows(rows, next, BEFORE),
    { op: 'canvas.test', by: 'outside:orchestrator' },
    copies,
  );
}
const withNodes = (nodes: CanvasNode[]): CanvasDocument => ({ ...BEFORE, nodes });
/** `node` at the top of the canvas, or in `parent`. */
function inside(node: CanvasNode, parent?: string): CanvasNode {
  const moved = { ...node };
  if (parent === undefined) delete moved.parentId;
  else moved.parentId = parent;
  return moved;
}

describe('changeSetOf', () => {
  it('holds each entity it touched, as it was and is, with its revision before', () => {
    const [, , , peer] = BEFORE.nodes as [CanvasNode, CanvasNode, CanvasNode, CanvasNode];
    const change = changeTo({
      ...withNodes([...BEFORE.nodes.slice(0, 3), { ...peer, data: { label: 'Partner' } }]),
      links: [],
    });
    expect(change).toMatchObject({ canvas: CANVAS, op: 'canvas.test', by: 'outside:orchestrator' });
    expect([...change.entities.keys()]).toEqual([nodeKey('peer'), linkKey('lead', 'peer')]);
    expect(change.entities.get(nodeKey('peer'))).toMatchObject({
      before: { label: 'Peer' },
      after: { label: 'Partner' },
      rev: 4,
    });
    expect(change.entities.get(linkKey('lead', 'peer'))).toMatchObject({ after: null, rev: 4 });
    expect([...change.created, ...change.removed, ...change.manager.keys()]).toEqual([]);
  });

  it('says which agents it created and removed, and which existed before it', () => {
    const helper: CanvasNode = {
      id: 'helper',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Helper' },
    };
    const copies = new Map([['helper', 'peer']]);
    const change = changeTo(
      { ...withNodes([...BEFORE.nodes.slice(0, 3), helper]), links: [] },
      copies,
    );
    expect([...change.created]).toEqual(['helper']);
    expect([...change.removed]).toEqual(['peer']);
    expect(change.entities.get(nodeKey('helper'))).toMatchObject({ before: null, rev: null });
    expect(change.copies).toBe(copies);
    expect(change.existed('peer')).toBe(true);
    expect(change.existed('helper')).toBe(false);
    // A frame is no agent.
    expect(change.existed('crew')).toBe(false);
  });

  it('counts a node that keeps its id but becomes an agent as created, and one that stops being one as removed', () => {
    const [lead, crew, worker, peer] = BEFORE.nodes as [
      CanvasNode,
      CanvasNode,
      CanvasNode,
      CanvasNode,
    ];
    // The crew made an agent, as addParent makes a group's frame its lead, with a startup mode.
    const made = changeTo(
      withNodes([
        lead,
        {
          ...crew,
          type: 'agent',
          data: { label: 'Crew lead', settings: { 'claude-code': { mode: 'acceptEdits' } } },
        },
        worker,
        peer,
      ]),
    );
    expect([...made.created]).toEqual(['crew']);
    expect(made.existed('crew')).toBe(false);
    // The peer made a frame.
    const unmade = changeTo({
      ...withNodes([lead, crew, worker, { ...peer, type: 'frame', data: { label: 'Peer' } }]),
      links: [],
    });
    expect([...unmade.removed]).toEqual(['peer']);
  });

  it('says whose manager it changed: the nearest agent each existing agent is in', () => {
    const [lead, crew, worker, peer] = BEFORE.nodes as [
      CanvasNode,
      CanvasNode,
      CanvasNode,
      CanvasNode,
    ];
    // The worker moves out of the crew to the top; the peer into the crew, under the lead.
    const moved = changeTo(withNodes([lead, crew, inside(worker), inside(peer, 'crew')]));
    expect(Object.fromEntries(moved.manager)).toEqual({
      worker: ['lead', null],
      peer: [null, 'lead'],
    });
    // The crew moved to the top takes the worker out from under the lead, though the worker's own
    // node is unchanged.
    const frame = changeTo(withNodes([lead, inside(crew), worker, peer]));
    expect(Object.fromEntries(frame.manager)).toEqual({ worker: ['lead', null] });
    // Renaming changes no manager.
    expect(
      changeTo(withNodes([{ ...lead, data: { label: 'Head' } }, crew, worker, peer])).manager.size,
    ).toBe(0);
  });

  it('holds an item’s change with its agent unchanged', () => {
    const worker = BEFORE.nodes[2] as CanvasNode & { type: 'agent' };
    const change = changeTo(
      withNodes([
        ...BEFORE.nodes.slice(0, 2),
        { ...worker, data: { ...worker.data, queue: [{ id: 'ok', approve: 'the fix' }] } },
        ...BEFORE.nodes.slice(3),
      ]),
    );
    expect([...change.entities.keys()]).toEqual([itemKey('worker', 'ok')]);
  });
});
