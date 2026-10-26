import { describe, expect, it } from 'vitest';

import { newCanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { META, toRows } from '../../../shared/model/rows';
import type { Entities, Entity } from '../../../shared/model/state';
import { canvasStateOf } from '../../../shared/model/state';
import type { AgentCaller, OutsideCaller } from '../caller';
import { asHuman } from '../gui';
import { seesAll, viewOf } from './view';

/*
 * What of a canvas a caller sees (Core Server §3.4): you and a token reaching its whole canvas see
 * it all; a lead sees the agents it reaches, the groups around them and the links between them, a
 * node inside one it doesn't see placed where it is on the canvas.
 */

const canvas = newCanvasId();
/**
 * `lead` inside the frame `team`, with `helper` nested inside it; `partner` linked to the lead,
 * nested inside `boss`, an agent the lead doesn't reach, inside the frame `office`; `stranger` and
 * the empty frame `empty` on their own.
 */
const document: CanvasDocument = {
  id: canvas,
  arrange: false,
  nodes: [
    { id: 'team', type: 'frame', position: { x: 10, y: 10 }, data: { label: 'Team' } },
    {
      id: 'lead',
      type: 'agent',
      parentId: 'team',
      position: { x: 20, y: 50 },
      data: { label: 'Lead', queue: [{ id: 'lead-item', message: 'Lead the team' }] },
    },
    {
      id: 'helper',
      type: 'agent',
      parentId: 'lead',
      position: { x: 20, y: 50 },
      data: { label: 'Helper' },
    },
    { id: 'office', type: 'frame', position: { x: 1000, y: 0 }, data: { label: 'Office' } },
    {
      id: 'boss',
      type: 'agent',
      parentId: 'office',
      position: { x: 30, y: 40 },
      data: { label: 'Boss', role: 'Private', queue: [{ id: 'boss-item', message: 'Secret' }] },
    },
    {
      id: 'partner',
      type: 'agent',
      parentId: 'boss',
      position: { x: 5, y: 6 },
      data: { label: 'Partner' },
    },
    { id: 'stranger', type: 'agent', position: { x: 0, y: 900 }, data: { label: 'Stranger' } },
    { id: 'empty', type: 'frame', position: { x: 0, y: 1200 }, data: { label: 'Empty' } },
  ],
  links: [
    { source: 'lead', target: 'partner' },
    { source: 'boss', target: 'stranger' },
    { source: 'helper', target: 'partner' },
  ],
};
const entities: Entities = Object.fromEntries(
  Object.entries(toRows(document)).map(([key, row]) => [
    key,
    (key === META
      ? { ...row, name: null, edited: false, project: null, rev: 0, by: 'you' }
      : { ...row, rev: 1, by: 'you' }) as Entity,
  ]),
);
const lead: AgentCaller = { kind: 'agent', canvas, agent: 'lead', session: 'lead-session' };
const outside: OutsideCaller = {
  kind: 'outside',
  token: 'token',
  name: 'orchestrator',
  access: 'write',
  merge: true,
  canvases: [canvas],
};

describe('what of a canvas a caller sees', () => {
  it('is all of it, the very entities, for you and a token reaching its whole canvas', () => {
    expect(viewOf(document, entities, asHuman(1), 'all', false)).toBe(entities);
    expect(viewOf(document, entities, outside, 'canvas', false)).toBe(entities);
    expect(seesAll(asHuman(1), 'all')).toBe(true);
    expect(seesAll(outside, 'canvas')).toBe(true);
    expect(seesAll(lead, 'linked')).toBe(false);
  });

  it('is, for a lead, the agents it reaches, the groups around them and the links between them', () => {
    const seen = viewOf(document, entities, lead, 'linked', true);
    const state = canvasStateOf(canvas, 1, seen);
    expect(state.nodes.map(({ id, parentId, position }) => ({ id, parentId, position }))).toEqual([
      { id: 'team', parentId: undefined, position: { x: 10, y: 10 } },
      { id: 'lead', parentId: 'team', position: { x: 20, y: 50 } },
      { id: 'helper', parentId: 'lead', position: { x: 20, y: 50 } },
      { id: 'office', parentId: undefined, position: { x: 1000, y: 0 } },
      // Inside the boss it doesn't reach: in the office, where it is on the canvas.
      { id: 'partner', parentId: 'office', position: { x: 35, y: 46 } },
    ]);
    expect(state.links).toEqual([
      { source: 'lead', target: 'partner' },
      { source: 'helper', target: 'partner' },
    ]);
    expect(Object.keys(state.entities)).not.toContain('item/boss/boss-item');
    expect(Object.keys(state.entities)).toContain('item/lead/lead-item');
    expect(JSON.stringify(seen)).not.toContain('Secret');
    expect(JSON.stringify(seen)).not.toContain('Private');
    // What it sees unchanged is the very entity.
    expect(seen['node/lead']).toBe(entities['node/lead']);
    expect(seen[META]).toBe(entities[META]);
  });

  it('is, for an agent that isn’t a lead, itself and those linked to it', () => {
    const helper: AgentCaller = { ...lead, agent: 'helper', session: 'helper-session' };
    const state = canvasStateOf(canvas, 1, viewOf(document, entities, helper, 'linked', false));
    expect(state.nodes.map(({ id }) => id)).toEqual([
      'team',
      'lead',
      'helper',
      'office',
      'partner',
    ]);
  });
});
