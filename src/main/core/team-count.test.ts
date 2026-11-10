import { describe, expect, it } from 'vitest';

import type { AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { diffRows, toRows } from '../../shared/model/rows';
import { CATALOG } from '../sessions/adapters';
import type { TokenCaller } from './caller';
import { changeSetOf } from './canvas/change';
import { changeChecks } from './rules';
import { CALLERS, CANVAS } from './test-registry';

/* R11 (B24 C8): a lead's cap counts what its whole team created, for each lead the creator is under. */

const [FIRST] = CATALOG.adapters as [(typeof CATALOG.adapters)[number]];

function agent(id: string, parentId?: string): AgentNode {
  return {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: id, adapter: FIRST.id, connection: FIRST.connections[0]?.id ?? '' },
    ...(parentId === undefined ? {} : { parentId }),
  };
}

const DOC: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [agent('lead'), agent('sub', 'lead'), agent('deep', 'sub')],
  links: [],
};

describe('R11: a lead’s cap counts its whole team', () => {
  // The lead's team has made eight; the sub-lead alone has made none.
  const counting = changeChecks({
    catalog: CATALOG,
    held: () => new Set(),
    created: (party) => (Array.isArray(party) && party.includes('agent:lead') ? 8 : 0),
    maxCreated: () => 8,
    isLead: (_canvas, id) => id === 'lead' || id === 'sub',
  });

  function adding(creator: string) {
    const rows = toRows(DOC);
    const fresh: CanvasDocument = { ...DOC, nodes: [...DOC.nodes, agent('ninth', creator)] };
    const change = changeSetOf(
      { document: DOC, rows, revs: new Map() },
      fresh,
      diffRows(rows, fresh, DOC),
      { op: 'canvas.addAgent', by: `agent:${creator}` },
    );
    return counting['new-agent'](change, {
      caller: { ...(CALLERS.lead as object), agent: creator } as TokenCaller,
      party: 'lead',
    });
  }

  it('refuses a sub-lead’s ninth agent once its lead’s team has eight', () => {
    expect(adding('sub')).toMatchObject({ refuse: expect.stringContaining('team') as unknown });
  });

  it('refuses the lead itself, and counts agents you create toward no one', () => {
    expect(adding('lead')).toMatchObject({ refuse: expect.stringContaining('team') as unknown });
    const quiet = changeChecks({
      catalog: CATALOG,
      held: () => new Set(),
      created: () => 0,
      maxCreated: () => 8,
      isLead: () => true,
    });
    const rows = toRows(DOC);
    const fresh: CanvasDocument = { ...DOC, nodes: [...DOC.nodes, agent('mine', 'lead')] };
    const change = changeSetOf(
      { document: DOC, rows, revs: new Map() },
      fresh,
      diffRows(rows, fresh, DOC),
      { op: 'canvas.addAgent', by: 'agent:lead' },
    );
    expect(
      quiet['new-agent'](change, { caller: CALLERS.lead as TokenCaller, party: 'lead' }),
    ).toBeUndefined();
  });
});
