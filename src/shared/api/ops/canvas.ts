import { z } from 'zod';

import { ID_PATTERN } from '../../adapter';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, NodeId, OpCanvas } from '../ids';
import { MAX_LABEL, MAX_MESSAGE_BYTES, MAX_OP_NODES, MAX_POSITION } from '../limits';
import { MAX_NODE_ID } from '../../model/canvas';
import type { OpName } from '../surface';
import { Role } from './agent';

const Coordinate = z.number().min(-MAX_POSITION).max(MAX_POSITION);
const Position = z.strictObject({ x: Coordinate, y: Coordinate });
const Ends = z.strictObject({ a: AgentId, b: AgentId });
const Nodes = z.array(NodeId).max(MAX_OP_NODES);
const CatalogId = z.string().min(1).max(32).regex(ID_PATTERN);
/** These keys name roles in the shipped template, not agents on the destination canvas. */
const TemplateRole = z.string().min(1).max(MAX_NODE_ID);
const Value = z
  .string()
  .max(MAX_MESSAGE_BYTES)
  .refine(
    (text) => new TextEncoder().encode(text).length <= MAX_MESSAGE_BYTES,
    `At most ${String(MAX_MESSAGE_BYTES)} bytes of UTF-8`,
  );
const Values = z
  .record(z.string().min(1).max(128), Value)
  .refine((values) => Object.keys(values).length <= 128, 'At most 128 template fields')
  .meta({ maxProperties: 128 });
const Agents = z
  .record(TemplateRole, CatalogId.nullable())
  .refine((agents) => Object.keys(agents).length <= MAX_OP_NODES, 'Too many template roles')
  .meta({ maxProperties: MAX_OP_NODES });
const Connections = z
  .record(TemplateRole, CatalogId)
  .refine(
    (connections) => Object.keys(connections).length <= MAX_OP_NODES,
    'Too many template roles',
  )
  .meta({ maxProperties: MAX_OP_NODES });

/** A canvas's project folder, which every caller may read (Core Server §3.4); none: not chosen. */
const Project = z.strictObject({ name: z.string(), path: z.string() }).nullable();
/** Who changed an entity last, and the revision of its canvas it took then. */
const Stamp = z.strictObject({ rev: z.int().min(0), by: z.string() });
/** A node of a canvas's document: an agent (its data holds its queue) or a frame. */
const CanvasNode = z.strictObject({
  id: z.string(),
  type: z.enum(['agent', 'frame']),
  position: Position,
  parentId: z.string().optional(),
  data: z.looseObject({
    label: z.string(),
    queue: z.array(z.looseObject({ id: z.string() })).optional(),
  }),
});
const CanvasLink = z.strictObject({
  source: z.string(),
  target: z.string(),
  // Where it leaves its source and meets its target: a pair (not a tuple, whose JSON Schema MCP's
  // clients may not read).
  dots: z.array(z.string()).length(2).optional(),
});

/** Canvas structure, by explicit node ids and undirected link ends. */
export const canvasOps = {
  'canvas.list': define('canvas.list', {
    summary:
      'The canvases you have, most recently used first: each one’s file name (null: never saved), ' +
      'whether it has edits not saved, whether its run is running, whether corrallm holds it open, ' +
      'its project folder, and the windows showing it.',
    input: z.strictObject({}),
    output: z.strictObject({
      items: z.array(
        z.strictObject({
          canvas: z.uuid(),
          name: z.string().nullable(),
          edited: z.boolean(),
          running: z.boolean(),
          open: z.boolean(),
          project: Project,
          shownIn: z.array(z.int()),
        }),
      ),
    }),
  }),
  'canvas.get': define('canvas.get', {
    summary:
      'A canvas: its agents and groups (each agent with its queue), the links between agents, its ' +
      'file name, whether it has edits not saved, its project folder, whether edits lay it out, and ' +
      'the revision and last writer of each of its entities by key (node/<id>, link/<a>/<b>, ' +
      'item/<agent>/<id>, meta), for `expect`. A lead sees the agents it reaches, the groups around ' +
      'them and the links between them.',
    input: z.strictObject({ canvas: OpCanvas }),
    output: z.strictObject({
      canvas: z.uuid(),
      rev: z.int().min(0),
      name: z.string().nullable(),
      edited: z.boolean(),
      project: Project,
      arrange: z.boolean(),
      nodes: z.array(CanvasNode),
      links: z.array(CanvasLink),
      entities: z.record(z.string(), Stamp),
    }),
  }),
  'canvas.rename': define('canvas.rename', {
    summary: 'Renames an agent or a group: the name the canvas shows it by.',
    input: z.strictObject({
      canvas: OpCanvas,
      node: NodeId,
      label: z.string().max(MAX_LABEL).regex(/\S/, 'A label must not be blank'),
    }),
    output: z.strictObject({}),
  }),
  'canvas.insertTemplate': define('canvas.insertTemplate', {
    summary:
      'Inserts a shipped template as a new group, returning its group and agent ids. ' +
      'Name a template from templates.list; values fill its fields, agents chooses adapters by ' +
      'template role id (null: the default adapter), and connections chooses their connections. ' +
      'Missing connections use each adapter’s first. Filled queue text records its author. ' +
      'A lead inserts inside its own agent unless parent names another node in its team.',
    input: z.strictObject({
      canvas: OpCanvas,
      template: z.uuid(),
      values: Values.default({}),
      agents: Agents.default({}),
      connections: Connections.default({}),
      parent: NodeId.optional(),
    }),
    output: z.strictObject({ group: NodeId, agents: z.array(AgentId).max(MAX_OP_NODES) }),
  }),
  'canvas.setArrange': define('canvas.setArrange', {
    summary: 'Turns automatic canvas layout on or off. Turning it on lays out the canvas once now.',
    input: z.strictObject({ canvas: OpCanvas, on: z.boolean() }),
    output: z.strictObject({}),
  }),
  'canvas.addAgent': define('canvas.addAgent', {
    summary:
      'Adds an agent at a canvas point, inside its innermost group, with a fresh queue and the ' +
      'role given, if one is (its standing instructions). A token gives a role only to an agent ' +
      'it creates, as it creates it.',
    input: z.strictObject({
      canvas: OpCanvas,
      at: Position,
      adapter: z.string().min(1).max(32).regex(ID_PATTERN),
      role: Role.optional(),
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
