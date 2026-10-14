import type { Edge } from '@xyflow/react';

import {
  CLI_MODES,
  CLIS,
  CONNECTIONS,
  EFFORT_PATTERN,
  MODEL_PATTERN,
  UNASKING_MODES,
} from '../../shared/session';
import type { AgentSettings, Cli, Connection } from '../../shared/session';
import { USAGE_BACKENDS, USAGE_WINDOWS } from '../../shared/usage';
import { AGENT_CONNECTIONS, AgentType, DEFAULT_AGENT } from './agents';
import type { AgentConnection } from './agents';
import { autosize, edgeId, GROUP_COLORS } from './graph';
import type { Graph, GraphNode } from './graph';
import { isRepeat, MAX_ROUNDS, MAX_SECONDS, sameTarget } from './queue';
import type {
  Condition,
  QueueDelay,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueStep,
  QueueWait,
  RepeatedItem,
  Time,
  Until,
  WaitTarget,
} from './queue';

/*
 * A canvas saved as a file (a `.corral`): JSON, versioned, holding only what the canvas means.
 * That is its agents and groups (where they are, what holds them, their queues) and the links
 * between agents. Selection, sizes (groups fit what they hold) and agents' questions are left out.
 *
 *   { "format": "corrallm", "version": 1,
 *     "nodes": [{ "id", "kind": "agent" | "group", "label", "position": { "x", "y" },
 *                 "parent"?, "agent"?, "connection"?, "settings"?, "color"?, "queue"? }],
 *     "links": [{ "agents": [id, id], "dots"?: [from, to] }] }
 *
 * A node's position is relative to its parent's, as React Flow keeps it. An agent's connection is
 * how it runs, if not simulated (a Claude agent's "terminal" or "sdk", a Codex agent's
 * "codex-terminal" or "app-server": agents.ts); where it runs (the project
 * folder) is not in the file, which main remembers per file instead. An agent's settings are what
 * it is set to run with in each CLI it has run, { "claude"?: { "model"?, "effort"?, "mode"? },
 * "codex"?: { … } }, each only if set (else the user's own default applies): a model's name, a
 * reasoning effort, and the mode its sessions start in, one of that CLI's that asks first (never
 * bypassing permissions or Codex's Full access, which are chosen in a session, each time). Queue items are as queue.ts
 * has them; a step may say what it is to do ("instruction", text: none when empty), and that it is
 * expected to fail ("expect": "fails"); a wait's targets are { "agent", "item"? }, and its time limit, if it has one, is
 * "timeout". A delay is { "id", "delay" }. A time (a delay's, or a time limit) is { "seconds" }, a
 * whole number from 1 to 604800 (7 days), { "at": "HH:MM" }, a 24-hour local time of day, or
 * { "resets": "fiveHour" | "weekly", "backend": "Claude" | "Codex" }, when that backend's usage
 * window resets (by its latest reading). An if-then's condition may be { "kind": "usageAbove",
 * "backend", "window", "percent" }: whether the backend's usage is over that share (1 to 99) of
 * the window. Usage rules are not in the file: they are the user's, kept by main. An OK
 * is { "id", "approve" }: what the user checks, in their words ("" for the work before it). A
 * repeat is { "id", "repeat", "until", "rounds", "otherwise" }: the steps, messages, waits and
 * delays it runs each round; when it stops (a condition, as an if-then has one, but not timedOut,
 * or { "kind": "repeatEnds", "agent", "item" } to go round with another agent's repeat); at most
 * how many rounds (1 to 20); and then "ask" or "goOn". Ids are unique across a queue, the items in
 * its repeats included, since waits name them. A link's dots are the ones it was drawn between
 * ("top" or "bottom"). Where the queues' run is, and what the user decided in it, is never saved.
 */
const FORMAT = 'corrallm';
const VERSION = 1;
const NOT_A_CANVAS = 'This is not a corrallm canvas';
const DOTS = ['top', 'bottom'];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

interface FileNode {
  id: string;
  kind: 'agent' | 'group';
  label: string;
  position: { x: number; y: number };
  parent?: string;
  agent?: AgentType;
  connection?: Connection;
  settings?: Partial<Record<Cli, AgentSettings>>;
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
    const { label, agent, connection, settings, color, queue } = n.data;
    return {
      id: n.id,
      kind: n.type === 'frame' ? 'group' : 'agent',
      label,
      position: { x: n.position.x, y: n.position.y },
      ...(n.parentId === undefined ? {} : { parent: n.parentId }),
      ...(agent === undefined ? {} : { agent }),
      ...(connection === undefined ? {} : { connection }),
      ...(settings === undefined ? {} : { settings }),
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
  connection,
  settings,
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
      ...(connection === undefined ? {} : { connection }),
      ...(settings === undefined ? {} : { settings }),
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
  const connection = optional(node.connection, `${where}.connection`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no connection`);
    const all: readonly AgentConnection[] = ['simulated', ...CONNECTIONS];
    const found = all.find((c) => c === v);
    if (found === undefined) throw new Error(`${at} must be one of: ${all.join(', ')}`);
    const type = agent ?? DEFAULT_AGENT;
    const offered = AGENT_CONNECTIONS[type];
    if (!offered.includes(found)) {
      const ways = `${offered.slice(0, -1).join(', ')}${offered.length > 1 ? ' or ' : ''}${offered.at(-1) ?? ''}`;
      throw new Error(`${at}: ${type} agents run only ${ways}`);
    }
    // Simulated is the default, kept as no connection at all.
    return found === 'simulated' ? undefined : found;
  });
  const settings = optional(node.settings, `${where}.settings`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no settings`);
    return readSettings(v, at);
  });
  const color = optional(node.color, `${where}.color`, (v, at) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= GROUP_COLORS) {
      throw new Error(`${at} must be a whole number from 0 to ${String(GROUP_COLORS - 1)}`);
    }
    return v;
  });
  const queue = optional(node.queue, `${where}.queue`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no queue`);
    return readQueue(v, at);
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
    ...(connection === undefined ? {} : { connection }),
    ...(settings === undefined ? {} : { settings }),
    ...(color === undefined ? {} : { color }),
    ...(queue === undefined ? {} : { queue }),
  };
}

/** An agent's settings, by CLI: undefined if nothing is set. */
function readSettings(value: unknown, where: string): FileNode['settings'] {
  const all: Partial<Record<Cli, AgentSettings>> = {};
  for (const [cli, given] of Object.entries(record(value, where))) {
    const at = `${where}.${cli}`;
    const known = CLIS.find((one) => one === cli);
    if (known === undefined) throw new Error(`${at}: settings are for ${CLIS.join(' or ')}`);
    const settings = record(given, at);
    if (Object.keys(settings).some((key) => !['model', 'effort', 'mode'].includes(key))) {
      throw new Error(`${at}: only model, effort and mode can be set`);
    }
    const model = optional(settings.model, `${at}.model`, (v, there) => {
      if (typeof v !== 'string' || !MODEL_PATTERN.test(v)) {
        throw new Error(`${there} must be a model's name, as its CLI takes it`);
      }
      return v;
    });
    const effort = optional(settings.effort, `${at}.effort`, (v, there) => {
      if (typeof v !== 'string' || !EFFORT_PATTERN.test(v)) {
        throw new Error(`${there} must be a reasoning effort, as its CLI names it`);
      }
      return v;
    });
    const asking = CLI_MODES[known].filter((mode) => !UNASKING_MODES.includes(mode));
    const mode = optional(settings.mode, `${at}.mode`, (v, there) => oneOf(v, there, asking));
    const set: AgentSettings = {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(mode === undefined ? {} : { mode }),
    };
    if (Object.keys(set).length > 0) all[known] = set;
  }
  return Object.keys(all).length === 0 ? undefined : all;
}

/**
 * A queue: its items, with ids unique across it, the items in its repeats included (waits name
 * them).
 */
function readQueue(value: unknown, where: string): QueueItem[] {
  const queue = items(value, where, readItem);
  const ids = new Set(queue.map((item) => item.id));
  for (const [i, item] of queue.entries()) {
    if (!isRepeat(item)) continue;
    for (const [j, inner] of item.repeat.entries()) {
      if (ids.has(inner.id)) {
        throw new Error(
          `${where}[${String(i)}].repeat[${String(j)}].id: "${inner.id}" is used twice in this queue`,
        );
      }
      ids.add(inner.id);
    }
  }
  return queue;
}

function readItem(value: unknown, where: string): QueueItem {
  const item = record(value, where);
  if ('waitFor' in item) return readWait(item, where);
  if ('delay' in item) return readDelay(item, where);
  if ('approve' in item) {
    return { id: name(item.id, `${where}.id`), approve: text(item.approve, `${where}.approve`) };
  }
  if ('repeat' in item) return readRepeat(item, where);
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
  if ('delay' in item) throw new Error(`${where}: an if-then cannot hold a delay`);
  if ('approve' in item) throw new Error(`${where}: an if-then cannot hold an OK`);
  if ('repeat' in item) throw new Error(`${where}: an if-then cannot hold a repeat`);
  const id = name(item.id, `${where}.id`);
  const target = optional(item.target, `${where}.target`, name);
  const aimed = target === undefined ? {} : { target };
  if ('message' in item) return { id, message: text(item.message, `${where}.message`), ...aimed };
  const instruction = optional(item.instruction, `${where}.instruction`, text);
  const expect = optional(item.expect, `${where}.expect`, (v, at): 'fails' => {
    if (v !== 'fails') throw new Error(`${at} must be "fails"`);
    return v;
  });
  return {
    id,
    action: name(item.action, `${where}.action`),
    ...aimed,
    ...(instruction === undefined || instruction === '' ? {} : { instruction }),
    ...(expect === undefined ? {} : { expect }),
  };
}

function readRepeat(item: Record<string, unknown>, where: string): QueueRepeat {
  const id = name(item.id, `${where}.id`);
  const repeat = items(item.repeat, `${where}.repeat`, readRepeated);
  const until = readUntil(item.until, `${where}.until`);
  const { rounds, otherwise } = item;
  if (
    typeof rounds !== 'number' ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > MAX_ROUNDS
  ) {
    throw new Error(`${where}.rounds must be a whole number from 1 to ${String(MAX_ROUNDS)}`);
  }
  if (otherwise !== 'ask' && otherwise !== 'goOn') {
    throw new Error(`${where}.otherwise must be "ask" or "goOn"`);
  }
  return { id, repeat, until, rounds, otherwise };
}

/** What a repeat holds: a step, a message, a wait or a delay. */
function readRepeated(value: unknown, where: string): RepeatedItem {
  const item = record(value, where);
  if ('if' in item) throw new Error(`${where}: a repeat cannot hold an if-then`);
  if ('repeat' in item) throw new Error(`${where}: a repeat cannot hold a repeat`);
  if ('approve' in item) throw new Error(`${where}: a repeat cannot hold an OK`);
  if ('waitFor' in item) return readWait(item, where);
  if ('delay' in item) return readDelay(item, where);
  return readStep(value, where);
}

function readWait(item: Record<string, unknown>, where: string): QueueWait {
  const waitFor = list(item.waitFor, `${where}.waitFor`, readTarget);
  if (waitFor.length === 0) throw new Error(`${where}.waitFor must name at least one agent`);
  const timeout = optional(item.timeout, `${where}.timeout`, readTime);
  return {
    id: name(item.id, `${where}.id`),
    waitFor: waitFor.filter((target, i) => waitFor.findIndex((t) => sameTarget(t, target)) === i),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function readDelay(item: Record<string, unknown>, where: string): QueueDelay {
  return { id: name(item.id, `${where}.id`), delay: readTime(item.delay, `${where}.delay`) };
}

/**
 * `{ "seconds" }` (a whole number from 1 to MAX_SECONDS), `{ "at": "HH:MM" }`, or `{ "resets",
 * "backend" }`.
 */
function readTime(value: unknown, where: string): Time {
  const time = record(value, where);
  if (['seconds', 'at', 'resets'].filter((key) => key in time).length !== 1) {
    throw new Error(`${where} must have one of seconds, at or resets`);
  }
  if ('resets' in time) {
    return {
      resets: oneOf(time.resets, `${where}.resets`, USAGE_WINDOWS),
      backend: oneOf(time.backend, `${where}.backend`, USAGE_BACKENDS),
    };
  }
  if ('at' in time) {
    if (typeof time.at !== 'string' || !CLOCK.test(time.at))
      throw new Error(`${where}.at must be a time like "09:00"`);
    return { at: time.at };
  }
  const { seconds } = time;
  if (
    typeof seconds !== 'number' ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > MAX_SECONDS
  ) {
    throw new Error(`${where}.seconds must be a whole number from 1 to ${String(MAX_SECONDS)}`);
  }
  return { seconds };
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
    case 'timedOut':
      return { kind: condition.kind };
    case 'outputContains':
      return readOutputCondition(condition, where);
    case 'freeText':
      return { kind: condition.kind, text: text(condition.text, `${where}.text`) };
    case 'usageAbove': {
      const { percent } = condition;
      if (
        typeof percent !== 'number' ||
        !Number.isInteger(percent) ||
        percent < 1 ||
        percent > 99
      ) {
        throw new Error(`${where}.percent must be a whole number from 1 to 99`);
      }
      return {
        kind: 'usageAbove',
        backend: oneOf(condition.backend, `${where}.backend`, USAGE_BACKENDS),
        window: oneOf(condition.window, `${where}.window`, USAGE_WINDOWS),
        percent,
      };
    }
    default:
      throw new Error(
        `${where}.kind must be one of: succeeded, failed, outputContains, timedOut, freeText, usageAbove`,
      );
  }
}

/** An output match, preserving whether it looks for text on a line of its own. */
function readOutputCondition(
  condition: Record<string, unknown>,
  where: string,
): Extract<Condition, { kind: 'outputContains' }> {
  const wholeLine = optional(condition.wholeLine, `${where}.wholeLine`, (value, at) => {
    if (typeof value !== 'boolean') throw new Error(`${at} must be true or false`);
    return value;
  });
  return {
    kind: 'outputContains',
    text: text(condition.text, `${where}.text`),
    ...(wholeLine === undefined ? {} : { wholeLine }),
  };
}

/** One of `allowed`, or throws naming them. */
function oneOf<T extends string>(value: unknown, where: string, allowed: readonly T[]): T {
  const found = allowed.find((one) => one === value);
  if (found === undefined) throw new Error(`${where} must be one of: ${allowed.join(', ')}`);
  return found;
}

/**
 * When a repeat stops: a condition (any but timedOut), or another agent's repeat to go round with,
 * `{ "kind": "repeatEnds", "agent", "item" }` (not checked against the canvas, like what a wait
 * waits for).
 */
function readUntil(value: unknown, where: string): Until {
  const until = record(value, where);
  switch (until.kind) {
    case 'succeeded':
    case 'failed':
      return { kind: until.kind };
    case 'outputContains':
      return readOutputCondition(until, where);
    case 'freeText':
      return { kind: until.kind, text: text(until.text, `${where}.text`) };
    case 'repeatEnds':
      return {
        kind: 'repeatEnds',
        agent: name(until.agent, `${where}.agent`),
        item: name(until.item, `${where}.item`),
      };
    default:
      throw new Error(
        `${where}.kind must be one of: succeeded, failed, outputContains, freeText, repeatEnds`,
      );
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

/** A queue, an if-then's steps or what a repeat holds: items with ids unique among them. */
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
