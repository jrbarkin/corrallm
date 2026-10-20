import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, NodeId, OpCanvas } from '../ids';
import { MAX_LABEL, MAX_OP_NODES } from '../limits';
import type { OpName } from '../surface';

const Position = z.strictObject({ x: z.number(), y: z.number() });
const Ends = z.strictObject({ a: AgentId, b: AgentId });
const Nodes = z.array(NodeId).max(MAX_OP_NODES);

/** Canvas structure, by explicit node ids and undirected link ends. */
export const canvasOps = {
  'canvas.rename': define('canvas.rename', {
    summary: 'Renames an agent or a group: the name the canvas shows it by.',
    input: z.strictObject({ canvas: OpCanvas, node: NodeId, label: z.string().max(MAX_LABEL) }),
    output: z.strictObject({}),
  }),
  'canvas.addAgent': define('canvas.addAgent', {
    summary: 'Adds an agent at a canvas point, inside its innermost group, with a fresh queue.',
    input: z.strictObject({
      canvas: OpCanvas,
      at: Position,
      adapter: z.string().min(1).max(32).regex(ID_PATTERN),
    }),
    output: z.strictObject({ id: AgentId }),
  }),
  'canvas.spawnAgent': define('canvas.spawnAgent', {
    summary:
      'Spawns a peer or linked agent, copying its source’s adapter, connection, settings and role with a fresh queue.',
    input: z.strictObject({
      canvas: OpCanvas,
      from: AgentId,
      relation: z.enum(['peer', 'linked']),
    }),
    output: z.strictObject({ id: AgentId }),
  }),
  'canvas.delete': define('canvas.delete', {
    summary:
      'Deletes explicit nodes and links, keeping children in place and reporting cleared queue references.',
    input: z.strictObject({
      canvas: OpCanvas,
      nodes: Nodes.optional(),
      links: z.array(Ends).max(MAX_OP_NODES).optional(),
    }),
    output: z.strictObject({ cleared: z.array(z.string()) }),
  }),
  'canvas.link': define('canvas.link', {
    summary:
      'Links two distinct agents once. Optional source (one end, default a) and dots preserve how the link is drawn.',
    input: z.strictObject({
      canvas: OpCanvas,
      a: AgentId,
      b: AgentId,
      source: AgentId.optional(),
      dots: z.tuple([z.enum(['top', 'bottom']), z.enum(['top', 'bottom'])]).optional(),
    }),
    output: z.strictObject({}),
  }),
  'canvas.unlink': define('canvas.unlink', {
    summary: 'Removes the link between two agents, whichever direction it was drawn in.',
    input: z.strictObject({ canvas: OpCanvas, a: AgentId, b: AgentId }),
    output: z.strictObject({}),
  }),
  'canvas.group': define('canvas.group', {
    summary:
      'Groups explicit nodes sharing a container under a new frame or agent, keeping their canvas positions.',
    input: z.strictObject({
      canvas: OpCanvas,
      nodes: Nodes.min(1),
      kind: z.enum(['frame', 'agent']),
    }),
    output: z.strictObject({ id: NodeId }),
  }),
  'canvas.ungroup': define('canvas.ungroup', {
    summary:
      'Ungroups explicit nodes, moving their children up without changing their canvas positions.',
    input: z.strictObject({ canvas: OpCanvas, nodes: Nodes }),
    output: z.strictObject({}),
  }),
  'canvas.addParent': define('canvas.addParent', {
    summary:
      'Turns a frame into an agent parent, keeping its id and children and adding a fresh queue.',
    input: z.strictObject({ canvas: OpCanvas, frame: NodeId }),
    output: z.strictObject({ id: AgentId }),
  }),
  'canvas.move': define('canvas.move', {
    summary:
      'Moves explicit nodes in their parents’ coordinates, fitting their groups once after all moves.',
    input: z.strictObject({
      canvas: OpCanvas,
      moves: z.array(z.strictObject({ node: NodeId, position: Position })).max(MAX_OP_NODES),
    }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;
