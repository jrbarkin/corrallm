import type { Edge } from '@xyflow/react';

import { AgentType } from './agents';
import { autosize, edgeId, GROUP_COLORS } from './graph';
import type { Graph, GraphNode } from './graph';
import { sameTarget } from './queue';
import type { Condition, QueueItem, QueueMessage, QueueStep, QueueWait, WaitTarget } from './queue';

/*
 * A canvas saved as a file (a `.corral`): JSON, versioned, holding only what the canvas means.
 * That is its agents and groups (where they are, what holds them, their queues) and the links
 * between agents. Selection, sizes (groups fit what they hold) and agents' questions are left out.
 *
 *   { "format": "corrallm", "version": 1,
 *     "nodes": [{ "id", "kind": "agent" | "group", "label", "position": { "x", "y" },
 *                 "parent"?, "agent"?, "color"?, "queue"? }],
 *     "links": [{ "agents": [id, id], "dots"?: [from, to] }] }
 *
 * A node's position is relative to its parent's, as React Flow keeps it. Queue items are as
 * queue.ts has them; a wait's targets are { "agent", "item"? }. A link's dots are the ones it was
 * drawn between ("top" or "bottom").
 */
const FORMAT = 'corrallm';
const VERSION = 1;
const NOT_A_CANVAS = 'This is not a corrallm canvas';
const DOTS = ['top', 'bottom'];

interface FileNode {
  id: string;
  kind: 'agent' | 'group';
  label: string;
  position: { x: number; y: number };
  parent?: string;
  agent?: AgentType;
  color?: number;
  queue?: QueueItem[];
}

interface FileLink {
  agents: [string, string];
  dots?: [string, string];
}

/** The canvas as the text of a `.corral` file. */
export function toFile(graph: Graph): string {
  const nodes = graph.nodes.map((n): FileNode => {
    const { label, agent, color, queue } = n.data;
    return {
      id: n.id,
      kind: n.type === 'frame' ? 'group' : 'agent',
      label,
      position: { x: n.position.x, y: n.position.y },
      ...(n.parentId === undefined ? {} : { parent: n.parentId }),
      ...(agent === undefined ? {} : { agent }),
      ...(color === undefined ? {} : { color }),
      ...(queue === undefined ? {} : { queue }),
    };
  });
  const links = graph.edges.map((e): FileLink => ({
    agents: [e.source, e.target],
    ...(e.sourceHandle && e.targetHandle ? { dots: [e.sourceHandle, e.targetHandle] } : {}),
  }));
  return `${JSON.stringify({ format: FORMAT, version: VERSION, nodes, links }, null, 2)}\n`;
}

/**
 * The canvas a `.corral` file holds. Throws, saying what is wrong and where, for anything that is
 * not a canvas this version can read.
 */
export function fromFile(text: string): Graph {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error(NOT_A_CANVAS);
  }
  if (!isRecord(file) || file.format !== FORMAT) throw new Error(NOT_A_CANVAS);
  const { version } = file;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('version must be a whole number');
  }
  if (version > VERSION) throw new Error('This canvas was made by a newer version of corrallm');

  const nodes = list(file.nodes, 'nodes', readNode);
  const byId = new Map<string, FileNode>();
  for (const [i, node] of nodes.entries()) {
    if (byId.has(node.id)) throw new Error(`nodes[${String(i)}].id: "${node.id}" is used twice`);
    byId.set(node.id, node);
  }
  for (const [i, node] of nodes.entries()) {
    const seen = new Set<string>();
    for (let up = node.parent; up !== undefined; up = byId.get(up)?.parent) {
      const where = `nodes[${String(i)}].parent`;
      if (!byId.has(up)) throw new Error(`${where}: there is no node "${up}"`);
      if (up === node.id) throw new Error(`${where}: "${node.id}" is inside itself`);
      if (seen.has(up)) break; // a loop above this node, reported for a node in it
      seen.add(up);
    }
  }

  // React Flow needs a parent before its children.
  const ordered: FileNode[] = [];
  const place = (node: FileNode) => {
    if (ordered.includes(node)) return;
    const parent = node.parent === undefined ? undefined : byId.get(node.parent);
    if (parent) place(parent);
    ordered.push(node);
  };
  nodes.forEach(place);

  const edges: Edge[] = [];
  const links = file.links === undefined ? [] : list(file.links, 'links', readLink);
  for (const [i, { agents, dots }] of links.entries()) {
    for (const id of agents) {
      if (byId.get(id)?.kind !== 'agent') {
        throw new Error(`links[${String(i)}].agents: there is no agent "${id}"`);
      }
    }
    const [source, target] = agents;
    const linked = edges.some(
      (e) =>
        (e.source === source && e.target === target) ||
        (e.source === target && e.target === source),
    );
    if (source === target || linked) continue;
    edges.push({
      id: edgeId(source, target),
      source,
      target,
      ...(dots ? { sourceHandle: dots[0], targetHandle: dots[1] } : {}),
    });
  }

  return { nodes: autosize(ordered.map(toGraphNode)), edges };
}

function toGraphNode({
  id,
  kind,
  label,
  position,
  parent,
  agent,
  color,
  queue,
}: FileNode): GraphNode {
  return {
    id,
    type: kind === 'group' ? 'frame' : 'agent',
    position,
    ...(parent === undefined ? {} : { parentId: parent }),
    data: {
      label,
      ...(agent === undefined ? {} : { agent }),
      ...(color === undefined ? {} : { color }),
      ...(queue === undefined ? {} : { queue }),
    },
  };
}

function readNode(value: unknown, where: string): FileNode {
  const node = record(value, where);
  const id = name(node.id, `${where}.id`);
  const { kind } = node;
  if (kind !== 'agent' && kind !== 'group') {
    throw new Error(`${where}.kind must be "agent" or "group"`);
  }
  const position = record(node.position, `${where}.position`);
  const agents: readonly string[] = Object.values(AgentType);
  const agent = optional(node.agent, `${where}.agent`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no agent`);
    const found = Object.values(AgentType).find((type) => type === v);
    if (found === undefined) throw new Error(`${at} must be one of: ${agents.join(', ')}`);
    return found;
  });
  const color = optional(node.color, `${where}.color`, (v, at) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= GROUP_COLORS) {
      throw new Error(`${at} must be a whole number from 0 to ${String(GROUP_COLORS - 1)}`);
    }
    return v;
  });
  const queue = optional(node.queue, `${where}.queue`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no queue`);
    return items(v, at, readItem);
  });
  return {
    id,
    kind,
    label: text(node.label, `${where}.label`),
    position: {
      x: number(position.x, `${where}.position.x`),
      y: number(position.y, `${where}.position.y`),
    },
    ...(node.parent === undefined ? {} : { parent: name(node.parent, `${where}.parent`) }),
    ...(agent === undefined ? {} : { agent }),
    ...(color === undefined ? {} : { color }),
    ...(queue === undefined ? {} : { queue }),
  };
}

function readItem(value: unknown, where: string): QueueItem {
  const item = record(value, where);
  if ('waitFor' in item) return readWait(item, where);
  if ('if' in item) {
    return {
      id: name(item.id, `${where}.id`),
      if: readCondition(item.if, `${where}.if`),
      then: items(item.then, `${where}.then`, readStep),
    };
  }
  return readStep(value, where);
}

/** A step or a message: what an if-then holds. */
function readStep(value: unknown, where: string): QueueStep | QueueMessage {
  const item = record(value, where);
  if ('if' in item) throw new Error(`${where}: an if-then cannot hold another if-then`);
  if ('waitFor' in item) throw new Error(`${where}: an if-then cannot hold a wait`);
  const id = name(item.id, `${where}.id`);
  const target = optional(item.target, `${where}.target`, name);
  const aimed = target === undefined ? {} : { target };
  if ('message' in item) return { id, message: text(item.message, `${where}.message`), ...aimed };
  return { id, action: name(item.action, `${where}.action`), ...aimed };
}

function readWait(item: Record<string, unknown>, where: string): QueueWait {
  const waitFor = list(item.waitFor, `${where}.waitFor`, readTarget);
  if (waitFor.length === 0) throw new Error(`${where}.waitFor must name at least one agent`);
  return {
    id: name(item.id, `${where}.id`),
    waitFor: waitFor.filter((target, i) => waitFor.findIndex((t) => sameTarget(t, target)) === i),
  };
}

/** `{ "agent", "item"? }`, or (as older files have it) just an agent's id. */
function readTarget(value: unknown, where: string): WaitTarget {
  if (typeof value === 'string') return { agent: name(value, where) };
  const target = record(value, where);
  const item = optional(target.item, `${where}.item`, name);
  return { agent: name(target.agent, `${where}.agent`), ...(item === undefined ? {} : { item }) };
}

function readCondition(value: unknown, where: string): Condition {
  const condition = record(value, where);
  switch (condition.kind) {
    case 'succeeded':
    case 'failed':
      return { kind: condition.kind };
    case 'outputContains':
    case 'freeText':
      return { kind: condition.kind, text: text(condition.text, `${where}.text`) };
    default:
      throw new Error(`${where}.kind must be one of: succeeded, failed, outputContains, freeText`);
  }
}

function readLink(value: unknown, where: string): FileLink {
  const link = record(value, where);
  const pair = (
    v: unknown,
    at: string,
    read: (one: unknown, at: string) => string,
  ): [string, string] => {
    if (!Array.isArray(v) || v.length !== 2) throw new Error(`${at} must be a pair`);
    return [read(v[0], `${at}[0]`), read(v[1], `${at}[1]`)];
  };
  const dot = (v: unknown, at: string) => {
    if (typeof v !== 'string' || !DOTS.includes(v))
      throw new Error(`${at} must be "top" or "bottom"`);
    return v;
  };
  const dots = optional(link.dots, `${where}.dots`, (v, at) => pair(v, at, dot));
  return { agents: pair(link.agents, `${where}.agents`, name), ...(dots ? { dots } : {}) };
}

/** A queue or an if-then's steps: items with ids unique among them. */
function items<T extends { id: string }>(
  value: unknown,
  where: string,
  read: (value: unknown, where: string) => T,
): T[] {
  const all = list(value, where, read);
  const ids = new Set<string>();
  for (const [i, item] of all.entries()) {
    if (ids.has(item.id)) throw new Error(`${where}[${String(i)}].id: "${item.id}" is used twice`);
    ids.add(item.id);
  }
  return all;
}

function list<T>(value: unknown, where: string, read: (value: unknown, where: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  return value.map((one: unknown, i) => read(one, `${where}[${String(i)}]`));
}

function optional<T>(
  value: unknown,
  where: string,
  read: (value: unknown, where: string) => T,
): T | undefined {
  return value === undefined ? undefined : read(value, where);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be text`);
  return value;
}

/** An id, or a name like an action's: text that is not empty. */
function name(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} must be non-empty text`);
  return value;
}

function number(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${where} must be a number`);
  return value;
}
