import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentId, CanvasId, idsIn, ItemId, WorktreeId } from '../../shared/api/ids';
import type { CanvasId as Canvas } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { AgentCaller, OutsideCaller } from './caller';
import type { Engines } from './engines';
import { outOfReach, resolvers } from './reach';
import type { Resolver } from './reach';

/*
 * Reach (Core Server §3.1, B9 Design §6): what each kind of id a token names resolves to on the
 * canvas it names. A node is what it is (an agent, or a group of agents); a group is every agent
 * of it; a queue item is one of the queue of the agent named beside it.
 */

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as Canvas;

/**
 * The lead, with a helper and a crew frame (holding the apprentice) nested inside it; a worker,
 * outside it, with a queue; and an empty frame.
 */
const DOCUMENT: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [
    { id: 'lead', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Lead' } },
    {
      id: 'helper',
      type: 'agent',
      parentId: 'lead',
      position: { x: 0, y: 0 },
      data: {
        label: 'Helper',
        queue: [
          { id: 'plan', message: 'Plan it' },
          { id: 'check', if: { kind: 'failed' }, then: [{ id: 'fix', message: 'Fix it' }] },
        ],
      },
    },
    { id: 'crew', type: 'frame', parentId: 'lead', position: { x: 0, y: 0 }, data: { label: 'C' } },
    {
      id: 'apprentice',
      type: 'agent',
      parentId: 'crew',
      position: { x: 0, y: 0 },
      data: { label: 'Apprentice' },
    },
    {
      id: 'worker',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: 'Worker', queue: [{ id: 'build', message: 'Build it' }] },
    },
    { id: 'empty', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Empty' } },
  ],
  links: [],
};

const LEAD: AgentCaller = { kind: 'agent', canvas: CANVAS, agent: 'lead', session: 'lead-session' };
const ORCHESTRATOR: OutsideCaller = {
  kind: 'outside',
  token: 'write-token',
  name: 'orchestrator',
  access: 'write',
  canvases: [CANVAS],
};

const engines = {
  canvas: (canvas: Canvas) => (canvas === CANVAS ? { document: DOCUMENT } : undefined),
} as unknown as Engines;
const core = resolvers(engines, (canvas, agent) => canvas === CANVAS && agent === 'lead');

/** Whether the lead reaches `id` of the kind `brand`, for a write on its team. */
const leadReaches = (
  brand: 'NodeId' | 'GroupId' | 'ItemId' | 'EntityKey',
  id: string,
  agent?: string,
) => core[brand]?.(id, LEAD, 'team', { canvas: CANVAS, ...(agent === undefined ? {} : { agent }) });

describe('outOfReach', () => {
  it('resolves a queue item with the agent named beside it', () => {
    const seen: unknown[] = [];
    const items: Resolver = (id, _caller, _reach, at) => {
      seen.push([id, at]);
      return at.agent === 'worker' && id === 'build';
    };
    const input = z.strictObject({
      canvas: CanvasId,
      agent: AgentId,
      item: ItemId,
      waitFor: z.array(z.strictObject({ agent: AgentId, item: ItemId })).max(4),
    });
    const args = {
      canvas: CANVAS,
      agent: 'worker',
      item: 'build',
      waitFor: [{ agent: 'lead', item: 'plan' }],
    };
    expect(
      outOfReach(idsIn(input, input.parse(args)), ORCHESTRATOR, 'canvas', {
        CanvasId: () => true,
        AgentId: () => true,
        ItemId: items,
      }),
    ).toBe('There is no queue item plan (at waitFor[0].item).');
    expect(seen).toEqual([
      ['build', { canvas: CANVAS, agent: 'worker' }],
      ['plan', { canvas: CANVAS, agent: 'lead' }],
    ]);
  });
});

describe('the core’s resolvers', () => {
  it('grants no token reach to a worktree, even on its own canvas', () => {
    const worktree = '22222222-2222-4222-8222-222222222222';
    const input = z.strictObject({ canvas: CanvasId, worktree: WorktreeId });
    const refs = idsIn(input, input.parse({ canvas: CANVAS, worktree }));
    for (const caller of [LEAD, ORCHESTRATOR])
      expect(outOfReach(refs, caller, 'canvas', core)).toBe(
        `There is no worktree ${worktree} (at worktree).`,
      );
  });

  it('resolve a node as what it is: an agent as itself, a frame as every agent of it', () => {
    // The lead's team holds the helper and what the crew holds, not the worker outside it.
    expect(leadReaches('NodeId', 'helper')).toBe(true);
    expect(leadReaches('NodeId', 'crew')).toBe(true);
    expect(leadReaches('NodeId', 'worker')).toBe(false);
    expect(leadReaches('NodeId', 'ghost')).toBe(false);
    // An agent with agents inside it is reached as the agent it is, not as its group.
    expect(core.NodeId?.('lead', LEAD, 'own', { canvas: CANVAS })).toBe(true);
    expect(core.GroupId?.('lead', LEAD, 'own', { canvas: CANVAS })).toBe(false);
  });

  it('resolve a group as every agent of it, an agent with agents inside it included', () => {
    expect(leadReaches('GroupId', 'lead')).toBe(true);
    expect(leadReaches('GroupId', 'crew')).toBe(true);
    // An agent alone is no group.
    expect(leadReaches('GroupId', 'helper')).toBe(false);
    expect(leadReaches('GroupId', 'worker')).toBe(false);
  });

  it('resolve a queue item only in the queue of the agent named beside it, at any depth', () => {
    expect(leadReaches('ItemId', 'plan', 'helper')).toBe(true);
    expect(leadReaches('ItemId', 'fix', 'helper')).toBe(true);
    // Another agent's item, an item of none, or none named beside it.
    expect(leadReaches('ItemId', 'build', 'helper')).toBe(false);
    // An item of an agent the lead doesn't reach, though it is there.
    expect(leadReaches('ItemId', 'build', 'worker')).toBe(false);
    expect(leadReaches('ItemId', 'ghost', 'helper')).toBe(false);
    expect(leadReaches('ItemId', 'plan')).toBe(false);
    // An outside token reaches every item of its canvas's agents.
    expect(
      core.ItemId?.('build', ORCHESTRATOR, 'canvas', { canvas: CANVAS, agent: 'worker' }),
    ).toBe(true);
  });

  it('resolve an entity’s key as what it names: its node, both ends of its link, its item’s agent', () => {
    for (const key of ['node/helper', 'node/crew', 'item/helper/plan', 'item/helper/fix']) {
      expect(leadReaches('EntityKey', key), key).toBe(true);
    }
    for (const key of [
      'node/worker',
      'item/worker/build',
      'link/helper/worker',
      'node/ghost',
      'item/ghost/plan',
      'node/he%2',
      'node/%68elper',
      'meta',
    ]) {
      expect(leadReaches('EntityKey', key), key).toBe(false);
    }
    expect(leadReaches('EntityKey', 'link/apprentice/helper')).toBe(true);
    // An outside token reaches its whole canvas: whatever a key there names, there or not.
    for (const key of ['node/worker', 'item/worker/gone', 'link/ghost/worker']) {
      expect(core.EntityKey?.(key, ORCHESTRATOR, 'canvas', { canvas: CANVAS }), key).toBe(true);
    }
    expect(core.EntityKey?.('node/he%2', ORCHESTRATOR, 'canvas', { canvas: CANVAS })).toBe(false);
  });
});
