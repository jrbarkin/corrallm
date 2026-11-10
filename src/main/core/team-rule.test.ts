import { describe, expect, it } from 'vitest';

import type { AgentNode, CanvasDocument, CanvasNode } from '../../shared/model/canvas';
import { diffRows, toRows } from '../../shared/model/rows';
import { CATALOG } from '../sessions/adapters';
import type { TokenCaller } from './caller';
import { changeSetOf } from './canvas/change';
import { changeChecks } from './rules';
import { CALLERS, CANVAS } from './test-registry';

/*
 * R10 (B24 C8): a lead changes only its own team, whatever op built the change: the agents nested
 * inside it, and what it adds inside itself. Checked here on the change itself.
 */

function agent(id: string, parentId?: string, x = 0): AgentNode {
  return {
    id,
    type: 'agent',
    position: { x, y: 0 },
    data: { label: id },
    ...(parentId === undefined ? {} : { parentId }),
  };
}

const BEFORE: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [agent('lead'), agent('mine', 'lead'), agent('other'), agent('theirs', 'other')],
  links: [],
};

const checks = changeChecks({
  catalog: CATALOG,
  held: () => new Set(),
  created: () => 0,
  maxCreated: () => 8,
});

/** The team rule's outcome on the change `next` makes of BEFORE, as `caller` makes it. */
function verdict(next: CanvasDocument, caller: TokenCaller = CALLERS.lead as TokenCaller) {
  const rows = toRows(BEFORE);
  const change = changeSetOf(
    { document: BEFORE, rows, revs: new Map() },
    next,
    diffRows(rows, next, BEFORE),
    { op: 'canvas.batch', by: 'agent:lead' },
  );
  return checks.team(change, { caller, party: 'lead' });
}

const edit = (nodes: CanvasNode[]): CanvasDocument => ({ ...BEFORE, nodes });

describe('R10: a lead changes only its own team', () => {
  it('lets a lead add an agent inside itself and move its team', () => {
    const moved = BEFORE.nodes.map((node) =>
      node.id === 'mine' ? { ...node, position: { x: 5, y: 5 } } : node,
    );
    expect(verdict(edit([...moved, agent('fresh', 'lead')]))).toBeUndefined();
  });

  it('refuses an agent added outside the lead (a peer spawn, an addAgent elsewhere)', () => {
    expect(verdict(edit([...BEFORE.nodes, agent('peer')]))).toMatchObject({
      refuse: expect.stringContaining('team') as unknown,
    });
    expect(verdict(edit([...BEFORE.nodes, agent('inOther', 'other')]))).toMatchObject({
      refuse: expect.stringContaining('team') as unknown,
    });
  });

  it('refuses a change to an agent outside the team, but not one that only moved', () => {
    const renamed = BEFORE.nodes.map((node) =>
      node.id === 'other' ? { ...node, data: { ...node.data, label: 'Renamed' } } : node,
    );
    expect(verdict(edit(renamed))).toMatchObject({ refuse: expect.any(String) as unknown });
    const moved = BEFORE.nodes.map((node) =>
      node.id === 'other' ? { ...node, position: { x: 500, y: 9 } } : node,
    );
    expect(verdict(edit(moved))).toBeUndefined();
  });

  it('refuses removing an agent outside the team, a link out of it, and a change to meta', () => {
    expect(verdict(edit(BEFORE.nodes.filter((node) => node.id !== 'other')))).toMatchObject({
      refuse: expect.any(String) as unknown,
    });
    expect(verdict({ ...BEFORE, links: [{ source: 'mine', target: 'theirs' }] })).toMatchObject({
      refuse: expect.any(String) as unknown,
    });
    expect(verdict({ ...BEFORE, arrange: true })).toMatchObject({
      refuse: expect.any(String) as unknown,
    });
  });

  it('allows a link inside the team', () => {
    expect(verdict({ ...BEFORE, links: [{ source: 'lead', target: 'mine' }] })).toBeUndefined();
  });

  it('never applies to anyone but a lead', () => {
    const rows = toRows(BEFORE);
    const next = edit([...BEFORE.nodes, agent('peer')]);
    const change = changeSetOf(
      { document: BEFORE, rows, revs: new Map() },
      next,
      diffRows(rows, next, BEFORE),
      { op: 'canvas.addAgent', by: 'outside:orchestrator' },
    );
    expect(
      checks.team(change, {
        caller: CALLERS['outside-write'] as TokenCaller,
        party: 'outside-write',
      }),
    ).toBeUndefined();
  });
});
