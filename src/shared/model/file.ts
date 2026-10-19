import { adapterIn, connectionIn, ID_PATTERN, isStartMode } from '../adapter';
import type { AdapterId, Catalog, ConnectionId } from '../adapter';
import { CANVAS_VERSION, canvasHeader } from '../canvas';
import { parseRole } from '../role';
import { EFFORT_PATTERN, MODEL_PATTERN } from '../session';
import type { AgentSettings } from '../session';
import { USAGE_WINDOWS } from '../usage';
import { MAX_NODE_ID } from './canvas';
import type { CanvasDocument, CanvasNode, Link } from './canvas';
import { GROUP_COLORS } from './geometry';
import { isRepeat, MAX_ROUNDS, MAX_SECONDS, sameTarget } from './queue';
import { PARTY_PATTERN } from './messages';
import type { PartyId } from './messages';
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
 * That is its id (a UUID: what main remembers of it is kept by it, src/shared/canvas.ts), its
 * agents and groups (where they are, what holds them, their queues) and the links between agents.
 * Selection and sizes (groups fit what they hold) are left out. A file of another version is
 * refused. The agents' adapters, connections and modes are read against the catalog
 * (src/shared/adapter.ts).
 *
 *   { "format": "corrallm", "version": 2, "id", "arrange"?: true,
 *     "nodes": [{ "id", "kind": "agent" | "group", "label", "position": { "x", "y" },
 *                 "parent"?, "adapter"?, "connection"?, "settings"?, "role"?, "color"?, "queue"? }],
 *     "links": [{ "agents": [id, id], "dots"?: [from, to] }] }
 *
 * A node's position is relative to its parent's, as the model keeps it (canvas.ts). An agent's
 * adapter is the agent it runs (the default agent's when omitted, as a template may leave it: whoever
 * reads the file says which that is), and its connection
 * how it runs (its adapter's first when omitted); where it runs (the project folder) is not in the
 * file, which main remembers per file instead. An adapter or connection the catalog lacks opens as
 * Not connected, and is saved back as it was, with that adapter's settings (checked for shape
 * only); a connection the catalog has under another adapter is refused. An agent's settings are
 * what it is set to run with by each adapter it has run, { "<adapter>": { "model"?, "effort"?,
 * "mode"? } }, each only if set (else the user's own default applies): a model's name, a reasoning
 * effort, and the mode its sessions start in, one that asks which its connection starts in (for
 * its own adapter, the connection it runs; for another, any of that adapter's): never one that
 * never asks, which is chosen in a session, each time. Queue items are as queue.ts has them; a
 * step may say what it is to do ("instruction", text: none when empty), and that it is expected to
 * fail ("expect": "fails"); a wait's targets are { "agent", "item"? }, and its time limit, if it
 * has one, is "timeout". A delay is { "id", "delay" }. A time (a delay's, or a time limit) is
 * { "seconds" }, a whole number from 1 to 604800 (7 days), { "at": "HH:MM" }, a 24-hour local time
 * of day, or { "resets": "fiveHour" | "weekly", "backend" }, when that usage backend's window
 * resets (by its latest reading). An if-then's condition may be { "kind": "usageAbove", "backend",
 * "window", "percent" }: whether the backend's usage is over that share (1 to 99) of the window.
 * A backend is named by its id: one the catalog lacks is kept, and has no reading. Usage rules are not in the file: they are the user's, kept by main. An OK
 * is { "id", "approve" }: what the user checks, in their words ("" for the work before it). A
 * repeat is { "id", "repeat", "until", "rounds", "otherwise" }: the steps, messages, waits and
 * delays it runs each round; when it stops (a condition, as an if-then has one, but not timedOut,
 * or { "kind": "repeatEnds", "agent", "item" } to go round with another agent's repeat); at most
 * how many rounds (1 to 20); and then "ask" or "goOn". Ids are unique across a queue, the items in
 * its repeats included, since waits name them. A link's dots are the ones it was drawn between
 * ("top" or "bottom"). Where the queues' run is, and what the user decided in it, is never saved.
 */
const FORMAT = 'corrallm';
const NOT_A_CANVAS = 'This is not a corrallm canvas';
const DOTS = ['top', 'bottom'];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

interface FileNode {
  id: string;
  kind: 'agent' | 'group';
  label: string;
  position: { x: number; y: number };
  parent?: string;
  adapter?: AdapterId;
  connection?: ConnectionId;
  settings?: Partial<Record<AdapterId, AgentSettings>>;
  role?: string;
  color?: number;
  queue?: QueueItem[];
}

interface FileLink {
  agents: [string, string];
  dots?: [string, string];
}

/** A canvas as the text of its `.corral` file. */
export function toFile({ id, arrange, nodes, links }: CanvasDocument): string {
  const saved = nodes.map((n): FileNode => {
    const agent = n.type === 'agent' ? n.data : undefined;
    const role = readRole(agent?.role, `${n.id}.role`);
    return {
      id: n.id,
      kind: n.type === 'frame' ? 'group' : 'agent',
      label: n.data.label,
      position: { x: n.position.x, y: n.position.y },
      ...(n.parentId === undefined ? {} : { parent: n.parentId }),
      ...(agent?.adapter === undefined ? {} : { adapter: agent.adapter }),
      ...(agent?.connection === undefined ? {} : { connection: agent.connection }),
      ...(agent?.settings === undefined ? {} : { settings: agent.settings }),
      ...(role === undefined ? {} : { role }),
      ...(n.data.color === undefined ? {} : { color: n.data.color }),
      ...(agent?.queue === undefined ? {} : { queue: agent.queue }),
    };
  });
  const drawn = links.map(({ source, target, dots }): FileLink => ({
    agents: [source, target],
    ...(dots ? { dots } : {}),
  }));
  return `${JSON.stringify({ format: FORMAT, version: CANVAS_VERSION, id, ...(arrange ? { arrange: true } : {}), nodes: saved, links: drawn }, null, 2)}\n`;
}

/**
 * The canvas a `.corral` file holds, read against `catalog`, an agent that names no adapter running
 * `defaultAdapter`. Throws, saying what is wrong and where, for anything that is not a canvas this
 * version can read.
 */
export function fromFile(
  text: string,
  catalog: Catalog,
  defaultAdapter: AdapterId,
): CanvasDocument {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error(NOT_A_CANVAS);
  }
  if (!isRecord(file)) throw new Error(NOT_A_CANVAS);
  const id = canvasHeader(file);
  const arrange =
    optional(file.arrange, 'arrange', (value, where) => {
      if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`);
      return value;
    }) ?? false;

  const nodes = list(file.nodes, 'nodes', (value, where) =>
    readNode(value, where, catalog, defaultAdapter),
  );
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

  // Parents come before their children.
  const ordered: FileNode[] = [];
  const place = (node: FileNode) => {
    if (ordered.includes(node)) return;
    const parent = node.parent === undefined ? undefined : byId.get(node.parent);
    if (parent) place(parent);
    ordered.push(node);
  };
  nodes.forEach(place);

  const links: Link[] = [];
  const drawn = file.links === undefined ? [] : list(file.links, 'links', readLink);
  for (const [i, { agents, dots }] of drawn.entries()) {
    for (const id of agents) {
      if (byId.get(id)?.kind !== 'agent') {
        throw new Error(`links[${String(i)}].agents: there is no agent "${id}"`);
      }
    }
    const [source, target] = agents;
    const linked = links.some(
      (l) =>
        (l.source === source && l.target === target) ||
        (l.source === target && l.target === source),
    );
    if (source === target || linked) continue;
    links.push({ source, target, ...(dots ? { dots: [dots[0], dots[1]] } : {}) });
  }

  return { id, arrange, nodes: ordered.map(toCanvasNode), links };
}

function toCanvasNode({
  id,
  kind,
  label,
  position,
  parent,
  adapter,
  connection,
  settings,
  role,
  color,
  queue,
}: FileNode): CanvasNode {
  const at = { id, position, ...(parent === undefined ? {} : { parentId: parent }) };
  if (kind === 'group') {
    return { ...at, type: 'frame', data: { label, ...(color === undefined ? {} : { color }) } };
  }
  return {
    ...at,
    type: 'agent',
    data: {
      label,
      ...(adapter === undefined ? {} : { adapter }),
      ...(connection === undefined ? {} : { connection }),
      ...(settings === undefined ? {} : { settings }),
      ...(role === undefined ? {} : { role }),
      ...(color === undefined ? {} : { color }),
      ...(queue === undefined ? {} : { queue }),
    },
  };
}

function readNode(
  value: unknown,
  where: string,
  catalog: Catalog,
  defaultAdapter: AdapterId,
): FileNode {
  const node = record(value, where);
  const id = name(node.id, `${where}.id`);
  if (id.length > MAX_NODE_ID) {
    throw new Error(`${where}.id must be at most ${String(MAX_NODE_ID)} characters`);
  }
  const { kind } = node;
  if (kind !== 'agent' && kind !== 'group') {
    throw new Error(`${where}.kind must be "agent" or "group"`);
  }
  const position = record(node.position, `${where}.position`);
  const adapter = optional(node.adapter, `${where}.adapter`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no adapter`);
    return catalogId(v, at, 'an adapter');
  });
  const connection = optional(node.connection, `${where}.connection`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no connection`);
    const named = catalogId(v, at, 'a connection');
    const owner = connectionIn(catalog, named)?.adapter.id;
    const runs = adapter ?? defaultAdapter;
    if (owner !== undefined && owner !== runs) {
      throw new Error(`${at}: "${named}" is a connection of ${owner}, not of ${runs}`);
    }
    return named;
  });
  const settings = optional(node.settings, `${where}.settings`, (v, at) => {
    if (kind === 'group') throw new Error(`${at}: a group has no settings`);
    return readSettings(v, at, catalog, adapter ?? defaultAdapter, connection);
  });
  const role = optional(node.role, `${where}.role`, (v, at) => {
    if (kind === 'group') throw new TypeError(`${at}: a group has no role`);
    return readRole(v, at);
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
    ...(adapter === undefined ? {} : { adapter }),
    ...(connection === undefined ? {} : { connection }),
    ...(settings === undefined ? {} : { settings }),
    ...(role === undefined ? {} : { role }),
    ...(color === undefined ? {} : { color }),
    ...(queue === undefined ? {} : { queue }),
  };
}

function readRole(value: unknown, where: string): string | undefined {
  try {
    return parseRole(value);
  } catch (error) {
    const message = `${where}: ${error instanceof Error ? error.message : 'Invalid role.'}`;
    throw error instanceof RangeError ? new RangeError(message) : new TypeError(message);
  }
}

/**
 * An agent's settings, by adapter: undefined if nothing is set. A mode must be one its adapter's
 * connection starts in: for the agent's own adapter (`adapter`), the connection it runs; for
 * another, any of that one's. An adapter the catalog lacks has its settings checked for shape only.
 */
function readSettings(
  value: unknown,
  where: string,
  catalog: Catalog,
  adapter: AdapterId,
  connection: ConnectionId | undefined,
): FileNode['settings'] {
  const all: Partial<Record<AdapterId, AgentSettings>> = {};
  for (const [key, given] of Object.entries(record(value, where))) {
    const at = `${where}.${key}`;
    if (!ID_PATTERN.test(key)) throw new Error(`${at}: settings are by adapter`);
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
    const known = adapterIn(catalog, key);
    // Its own adapter's settings start the connection it runs (its first, unless it names one);
    // another adapter's, or those of a connection its adapter lacks, any of that adapter's.
    const own = key === adapter ? (connection ?? known?.connections[0]?.id) : undefined;
    const runs = known?.connections.some((one) => one.id === own) ? own : undefined;
    const mode = optional(settings.mode, `${at}.mode`, (v, there) => {
      if (!known) return catalogId(v, there, 'a mode');
      const starts = known.modes
        .map((one) => one.id)
        .filter((one) => isStartMode(catalog, key, runs, one));
      return oneOf(v, there, starts);
    });
    const set: AgentSettings = {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(mode === undefined ? {} : { mode }),
    };
    if (Object.keys(set).length > 0) all[key] = set;
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
    return {
      id: name(item.id, `${where}.id`),
      ...author(item, where),
      approve: text(item.approve, `${where}.approve`),
    };
  }
  if ('repeat' in item) return readRepeat(item, where);
  if ('if' in item) {
    return {
      id: name(item.id, `${where}.id`),
      ...author(item, where),
      if: readCondition(item.if, `${where}.if`),
      then: items(item.then, `${where}.then`, readStep),
    };
  }
  return readStep(value, where);
}

/** Queue text keeps its author when the canvas is saved and opened again. */
function author(item: Record<string, unknown>, where: string): { by?: PartyId } {
  if (item.by === undefined) return {};
  if (typeof item.by !== 'string' || !PARTY_PATTERN.test(item.by))
    throw new Error(`${where}.by must be a party id`);
  return { by: item.by as PartyId };
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
  if ('message' in item)
    return {
      id,
      ...author(item, where),
      message: text(item.message, `${where}.message`),
      ...aimed,
    };
  const instruction = optional(item.instruction, `${where}.instruction`, text);
  const expect = optional(item.expect, `${where}.expect`, (v, at): 'fails' => {
    if (v !== 'fails') throw new Error(`${at} must be "fails"`);
    return v;
  });
  return {
    id,
    ...author(item, where),
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
  return { id, ...author(item, where), repeat, until, rounds, otherwise };
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
    ...author(item, where),
    waitFor: waitFor.filter((target, i) => waitFor.findIndex((t) => sameTarget(t, target)) === i),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function readDelay(item: Record<string, unknown>, where: string): QueueDelay {
  return {
    id: name(item.id, `${where}.id`),
    ...author(item, where),
    delay: readTime(item.delay, `${where}.delay`),
  };
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
      backend: catalogId(time.backend, `${where}.backend`, 'a usage backend'),
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

/** `{ "agent", "item"? }`. */
function readTarget(value: unknown, where: string): WaitTarget {
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
        backend: catalogId(condition.backend, `${where}.backend`, 'a usage backend'),
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

/** An id the catalog's ids look like (`what`: what it names, for the message). */
function catalogId(value: unknown, where: string, what: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${where} must be ${what}'s id`);
  }
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
