import type { Edge, Node, XYPosition } from '@xyflow/react';

import { isStartMode } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, CanvasDocument, CanvasNode } from '../../shared/model/canvas';
import { CARD_SIZE, EMPTY_FRAME, GROUP_COLORS, HEADER, PADDING } from '../../shared/model/geometry';
import { areLinked } from '../../shared/model/queries';
import { clearDeletedReferences } from '../../shared/model/references';
import { parseRole } from '../../shared/role';
import type { AgentSettings } from '../../shared/session';
import { catalog } from '../catalog';
import { connectionsOf, DEFAULT_AGENT, defaultConnection, translateActions } from './agents';
import type { AgentConnection } from './agents';
import {
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isWait,
  MAX_ROUNDS,
  sameTarget,
} from '../../shared/model/queue';
import type {
  Condition,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueStep,
  Time,
  WaitTarget,
} from '../../shared/model/queue';
import { sameTime } from '../../shared/model/time';

/**
 * `item`: a labelled node with a target handle (top) and a source handle (bottom). While it has
 * children it is their "parent node": a box around them, with the item's card centred on the
 * box's top border.
 * `frame`: a labelled box that only groups other nodes. It has no handles.
 * A frame, or an item with children, is a container. Containers are always sized to fit their
 * children (see `autosize`).
 */
export type NodeKind = 'agent' | 'frame';
/**
 * A node as React Flow draws it, wrapping what the model keeps of an agent (AgentData,
 * src/shared/model/canvas.ts: frames use only its label and colour) as the record React Flow takes
 * for a node's data. `color`: a group's colour, an index into the GROUP_COLORS palette
 * (GraphEditor.css). The run reads the model's nodes instead (canvasNodes).
 */
export type GraphNode = Node<{ [Key in keyof AgentData]: AgentData[Key] }, NodeKind>;
export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}

/**
 * The graph's nodes as the model keeps them (src/shared/model/canvas.ts), as the run reads them:
 * who each is and holds, and where, without what React Flow adds (selection, sizes, dragging). A
 * frame keeps its label and colour.
 */
export function canvasNodes(nodes: readonly GraphNode[]): CanvasNode[] {
  return nodes.map(({ id, type, position, parentId, data }): CanvasNode => {
    const at = {
      id,
      position: { x: position.x, y: position.y },
      ...(parentId === undefined ? {} : { parentId }),
    };
    if (type !== 'frame') return { ...at, type: 'agent', data };
    const { label, color } = data;
    return { ...at, type: 'frame', data: { label, ...(color === undefined ? {} : { color }) } };
  });
}

/**
 * A canvas as React Flow draws it (its file's, src/shared/model/file.ts): its nodes, groups sized to
 * fit what they hold, and its links as edges between the dots they were drawn between.
 */
export function graphOf({ nodes, links }: CanvasDocument): Graph {
  return {
    nodes: autosize(
      nodes.map(({ id, type, position, parentId, data }): GraphNode => ({
        id,
        type,
        position,
        ...(parentId === undefined ? {} : { parentId }),
        data,
      })),
    ),
    edges: links.map(({ source, target, dots }) => ({
      id: edgeId(source, target),
      source,
      target,
      ...(dots ? { sourceHandle: dots[0], targetHandle: dots[1] } : {}),
    })),
  };
}

/** The graph as the model keeps canvas `id` (what its file saves): its nodes, and its links. */
export function documentOf(graph: Graph, id: CanvasId): CanvasDocument {
  return {
    id,
    nodes: canvasNodes(graph.nodes),
    links: graph.edges.map(({ source, target, sourceHandle, targetHandle }) => ({
      source,
      target,
      ...(sourceHandle && targetHandle ? { dots: [sourceHandle, targetHandle] } : {}),
    })),
  };
}

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
/** Space between neighbouring nodes in a row, and between rows, as the canvas lays them out. */
export const NODE_GAP = 40;
export const RANK_GAP = 60;
/** How far "Add node" moves a new node that would land on another node's top-left corner. */
const NUDGE = 24;

interface Size {
  width: number;
  height: number;
}

export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

/** `Node N` or `Group N`, one more than the largest N already used with that prefix. */
export function nextLabel(nodes: readonly GraphNode[], prefix: 'Agent' | 'Group'): string {
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  let max = 0;
  for (const node of nodes) {
    const n = pattern.exec(node.data.label)?.[1];
    if (n !== undefined) max = Math.max(max, Number(n));
  }
  return `${prefix} ${String(max + 1)}`;
}

/**
 * Adds an item centred on `center` (flow coordinates) and makes it the only selected element. If
 * the point is inside a container, the item becomes a child of the innermost one, which grows to
 * fit it. A new item that would land exactly on another node is nudged down and right.
 */
export function addAgent(graph: Graph, id: string, center: XYPosition): Graph {
  const { nodes } = graph;
  const byId = indexById(nodes);
  let topLeft = {
    x: Math.round(center.x - CARD_SIZE.width / 2),
    y: Math.round(center.y - CARD_SIZE.height / 2),
  };
  const corners = nodes.map((n) => absolutePosition(n, byId));
  for (let i = 0; i < 50 && corners.some((c) => near(c, topLeft)); i++) {
    topLeft = { x: topLeft.x + NUDGE, y: topLeft.y + NUDGE };
  }
  const container = containerAt(nodes, {
    x: topLeft.x + CARD_SIZE.width / 2,
    y: topLeft.y + CARD_SIZE.height / 2,
  });
  const origin = container ? absolutePosition(container, byId) : { x: 0, y: 0 };
  const node = withParent(
    {
      id,
      type: 'agent',
      position: { x: topLeft.x - origin.x, y: topLeft.y - origin.y },
      data: { label: nextLabel(nodes, 'Agent'), ...newAgent(id) },
      selected: true,
    },
    container?.id,
  );
  return {
    nodes: autosize([...nodes.map((n) => select(n, false)), node]),
    edges: graph.edges.map((e) => select(e, false)),
  };
}

/**
 * Adds an agent spawned from agent `from` in its agent view: of the same type, connection,
 * settings and role, in the same group, and the only selected element. A `peer` goes beside it, in its row (the same top edge), to its
 * right. A `linked` one is linked to it, as drawing from its bottom dot lets two agents talk, and
 * goes below it, where the canvas's top-to-bottom layout puts what an agent links to (layout.ts),
 * in a row that starts under its left edge. Along its row it steps right past every card and group
 * in the way, so agents spawned one after another line up left to right. Its group grows to fit it.
 */
export function spawnAgent(
  graph: Graph,
  from: string,
  id: string,
  relation: 'peer' | 'linked',
): Graph {
  const source = graph.nodes.find((n) => n.id === from);
  if (source?.type !== 'agent') return graph;
  const { nodes } = graph;
  const byId = indexById(nodes);
  const parentIds = new Set(nodes.map((n) => n.parentId));
  /** A node's box on the canvas, with the half of a parent node's card that sits above its box. */
  const footprint = (n: GraphNode) => {
    const { x, y } = absolutePosition(n, byId);
    const { width, height } = size(n);
    const card = n.type === 'agent' && parentIds.has(n.id) ? CARD_SIZE.height / 2 : 0;
    return { x, y: y - card, width, height: height + card };
  };
  const ancestors = new Set<string>();
  for (let p = parentOf(source, byId); p; p = parentOf(p, byId)) ancestors.add(p.id);
  // Its own groups hold it; every other card and group is in the way if the new card would come
  // within a gap of it along the row, or within PADDING of it across.
  const others = nodes.filter((n) => !ancestors.has(n.id)).map(footprint);
  const inTheWay = (x: number, y: number) =>
    others.find(
      (o) =>
        x < o.x + o.width + NODE_GAP &&
        o.x < x + CARD_SIZE.width + NODE_GAP &&
        y < o.y + o.height + PADDING &&
        o.y < y + CARD_SIZE.height + PADDING,
    );
  const at = footprint(source);
  const spot =
    relation === 'peer'
      ? { x: at.x + at.width + NODE_GAP, y: at.y }
      : { x: at.x, y: at.y + at.height + RANK_GAP };
  // Each step passes one of them for good, so this ends.
  for (let o = inTheWay(spot.x, spot.y); o; o = inTheWay(spot.x, spot.y)) {
    spot.x = o.x + o.width + NODE_GAP;
  }
  const group = parentOf(source, byId);
  const origin = group ? absolutePosition(group, byId) : { x: 0, y: 0 };
  const node = withParent(
    {
      id,
      type: 'agent',
      position: { x: spot.x - origin.x, y: spot.y - origin.y },
      data: {
        label: nextLabel(nodes, 'Agent'),
        ...newAgent(id, source.data.adapter),
        ...(source.data.connection === undefined ? {} : { connection: source.data.connection }),
        ...(source.data.settings === undefined ? {} : { settings: source.data.settings }),
        ...(source.data.role === undefined ? {} : { role: source.data.role }),
      },
      selected: true,
    },
    group?.id,
  );
  const spawned = {
    nodes: autosize([...nodes.map((n) => select(n, false)), node]),
    edges: graph.edges.map((e) => select(e, false)),
  };
  return relation === 'linked'
    ? connect(spawned, { source: from, target: id, sourceHandle: 'bottom', targetHandle: 'top' })
    : spawned;
}

/**
 * What a new agent (node `id`) starts with besides its label: its adapter (the default agent's
 * unless given), and a queue that starts with a message to write, telling the agent what to do.
 */
function newAgent(
  id: string,
  adapter: AdapterId = DEFAULT_AGENT,
): Pick<GraphNode['data'], 'adapter' | 'queue'> {
  return { adapter, queue: [{ id: `${id}/message`, message: '' }] };
}

/** Sets a node's label. Any string is accepted, including an empty one. */
export function renameNode(graph: Graph, id: string, label: string): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || node.data.label === label) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n === node ? { ...n, data: { ...n.data, label } } : n)),
  };
}

/**
 * Sets the agent a node runs (its adapter), translating steps and dropping a connection its new
 * adapter does not offer, and a saved mode the connection it now runs does not start in. Groups
 * (frames) have none.
 */
export function setAgent(graph: Graph, id: string, adapter: AdapterId): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.type !== 'agent' || node.data.adapter === adapter) return graph;
  const { connection, settings, ...data } = node.data;
  const kept = connection !== undefined && connectionsOf(adapter).includes(connection);
  const queue = data.queue && translateActions(data.queue, data.adapter ?? DEFAULT_AGENT, adapter);
  const runs = kept ? connection : defaultConnection(adapter);
  return replace(graph, node, {
    ...data,
    adapter,
    ...(queue ? { queue } : {}),
    ...(kept ? { connection } : {}),
    ...fitted(settings, adapter, runs),
  });
}

/**
 * `settings`, without the mode saved for `adapter` if the connection it runs (`runs`) doesn't start
 * in it: what a file keeps of an agent's settings always reads back (src/shared/model/file.ts).
 */
function fitted(
  settings: GraphNode['data']['settings'],
  adapter: AdapterId,
  runs: AgentConnection,
): Pick<GraphNode['data'], 'settings'> {
  if (settings === undefined) return {};
  const mode = settings[adapter]?.mode;
  if (mode === undefined || runs === 'unavailable') return { settings };
  if (isStartMode(catalog(), adapter, runs, mode)) return { settings };
  const rest = { ...settings[adapter] };
  delete rest.mode;
  const kept = withSettings({ ...settings, [adapter]: rest });
  return kept === undefined ? {} : { settings: kept };
}

/** Each adapter's settings that set anything; undefined if none does. */
function withSettings(
  all: NonNullable<GraphNode['data']['settings']>,
): GraphNode['data']['settings'] {
  const kept = Object.entries(all).filter(
    (entry): entry is [string, AgentSettings] =>
      entry[1] !== undefined && Object.keys(entry[1]).length > 0,
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/** `graph` with `node`'s data replaced by `data`. */
function replace(graph: Graph, node: GraphNode, data: GraphNode['data']): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n === node ? { ...n, data } : n)) };
}

/**
 * Sets what an agent is set to run with by `adapter` (what is not in `settings` is the user's own
 * default); nothing set by any adapter leaves it no settings at all.
 */
export function setSettings(
  graph: Graph,
  id: string,
  adapter: AdapterId,
  settings: AgentSettings,
): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.type !== 'agent') return graph;
  const { settings: before = {}, ...data } = node.data;
  const kept = withSettings({ ...before, [adapter]: settings });
  return replace(graph, node, kept === undefined ? data : { ...data, settings: kept });
}

/** Sets the authored role without changing the agent's per-adapter settings or active session. */
export function setRole(graph: Graph, id: string, role: string | undefined): Graph {
  const node = graph.nodes.find((node) => node.id === id);
  if (node?.type !== 'agent') return graph;
  const parsed = parseRole(role);
  if (node.data.role === parsed) return graph;
  const data = { ...node.data };
  if (parsed === undefined) delete data.role;
  else data.role = parsed;
  return {
    ...graph,
    nodes: graph.nodes.map((entry) => (entry === node ? { ...entry, data } : entry)),
  };
}

/**
 * Sets the native connection, if its adapter offers it, dropping a saved mode that connection
 * doesn't start in.
 */
export function setConnection(graph: Graph, id: string, connection: AgentConnection): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  const adapter = node?.data.adapter ?? DEFAULT_AGENT;
  if (
    node?.type !== 'agent' ||
    connection === 'unavailable' ||
    !connectionsOf(adapter).includes(connection) ||
    node.data.connection === connection
  ) {
    return graph;
  }
  const { settings, ...data } = node.data;
  return replace(graph, node, { ...data, connection, ...fitted(settings, adapter, connection) });
}

/**
 * Appends an item to a node's queue, or with `into` (the id of an if-then or a repeat in it) to
 * what that holds: an if-then holds steps and messages; a repeat, waits and delays too. Neither
 * holds if-thens, repeats or OKs.
 */
export function addToQueue(graph: Graph, id: string, item: QueueItem, into?: string): Graph {
  return updateQueue(graph, id, (queue) => {
    if (into === undefined) return [...queue, item];
    if (isIf(item) || isRepeat(item) || isApproval(item)) return queue;
    return queue.map((q) => {
      if (q.id !== into) return q;
      if (isRepeat(q)) return { ...q, repeat: [...q.repeat, item] };
      return isIf(q) && !isWait(item) && !isDelay(item) ? { ...q, then: [...q.then, item] } : q;
    });
  });
}

/** Removes one item from a node's queue, or from an if-then or a repeat in it. */
export function removeFromQueue(graph: Graph, id: string, itemId: string): Graph {
  const keep = (q: QueueItem) => q.id !== itemId;
  return updateQueue(graph, id, (queue) =>
    queue
      .filter(keep)
      .map((q) =>
        isIf(q)
          ? withList(q, 'then', q.then.filter(keep))
          : isRepeat(q)
            ? withList(q, 'repeat', q.repeat.filter(keep))
            : q,
      ),
  );
}

/**
 * Moves an item to `index` in its list (the queue, an if-then's steps, or what a repeat holds),
 * clamped to its ends.
 */
export function moveInQueue(graph: Graph, id: string, itemId: string, index: number): Graph {
  return updateQueue(graph, id, (queue) =>
    queue.some((q) => q.id === itemId)
      ? moveTo(queue, itemId, index)
      : queue.map((q) =>
          isIf(q)
            ? withList(q, 'then', moveTo(q.then, itemId, index))
            : isRepeat(q)
              ? withList(q, 'repeat', moveTo(q.repeat, itemId, index))
              : q,
        ),
  );
}

/**
 * Sets which node a step acts on, or a message goes to; `undefined` makes it the node whose queue it
 * is in.
 */
export function retarget(
  graph: Graph,
  id: string,
  itemId: string,
  target: string | undefined,
): Graph {
  return mapItems(graph, id, itemId, (q) => {
    if (!isStep(q) || q.target === target) return q;
    const next = { ...q };
    if (target === undefined) delete next.target;
    else next.target = target;
    return next;
  });
}

/** Sets what a wait waits for (see WaitTarget). A wait waits for something: an empty list is ignored. */
export function setWaitFor(graph: Graph, id: string, waitId: string, targets: WaitTarget[]): Graph {
  if (targets.length === 0) return graph;
  const same = (waitFor: WaitTarget[]) =>
    waitFor.length === targets.length &&
    waitFor.every((target, i) => {
      const other = targets[i];
      return other !== undefined && sameTarget(target, other);
    });
  return mapItems(graph, id, waitId, (q) =>
    isWait(q) && !same(q.waitFor) ? { ...q, waitFor: targets } : q,
  );
}

/**
 * Sets a delay's time, or a wait's time limit (`undefined` takes the limit off). A delay always has
 * a time: `undefined` leaves it as it is.
 */
export function setTime(graph: Graph, id: string, itemId: string, time: Time | undefined): Graph {
  return mapItems(graph, id, itemId, (q) => {
    if (isDelay(q))
      return time === undefined || sameTime(q.delay, time) ? q : { ...q, delay: time };
    if (!isWait(q)) return q;
    if (time !== undefined)
      return q.timeout && sameTime(q.timeout, time) ? q : { ...q, timeout: time };
    if (q.timeout === undefined) return q;
    const untimed = { ...q };
    delete untimed.timeout;
    return untimed;
  });
}

/** Sets what an OK is on, in the user's words ('' for the work before it). */
export function setApproval(graph: Graph, id: string, okId: string, approve: string): Graph {
  return mapItems(graph, id, okId, (q) =>
    isApproval(q) && q.approve !== approve ? { ...q, approve } : q,
  );
}

/**
 * Changes a repeat: when it stops, how many rounds it runs at most (a whole number from 1 to
 * MAX_ROUNDS; others are rounded and clamped), or what it does after the last.
 */
export function setRepeat(
  graph: Graph,
  id: string,
  repeatId: string,
  change: Partial<Pick<QueueRepeat, 'until' | 'rounds' | 'otherwise'>>,
): Graph {
  return mapItems(graph, id, repeatId, (q) => {
    if (!isRepeat(q)) return q;
    const next = {
      ...q,
      ...change,
      rounds: Math.min(Math.max(Math.round(change.rounds ?? q.rounds), 1), MAX_ROUNDS),
    };
    const same =
      next.rounds === q.rounds &&
      next.otherwise === q.otherwise &&
      JSON.stringify(next.until) === JSON.stringify(q.until);
    return same ? q : next;
  });
}

/** Changes the text of a message in the queue (or in an if-then or a repeat in it). */
export function editMessage(graph: Graph, id: string, itemId: string, message: string): Graph {
  return mapItems(graph, id, itemId, (q) =>
    isMessage(q) && q.message !== message ? { ...q, message } : q,
  );
}

/** Says what a step is to do, in the user's words ('' takes it off). */
export function setInstruction(
  graph: Graph,
  id: string,
  itemId: string,
  instruction: string,
): Graph {
  return mapItems(graph, id, itemId, (q) => {
    if (!('action' in q) || (q.instruction ?? '') === instruction) return q;
    const step: QueueStep = { ...q, instruction };
    if (instruction === '') delete step.instruction;
    return step;
  });
}

/** Expects a step to fail ('fails'), or (undefined) to succeed, as steps do. */
export function setExpect(
  graph: Graph,
  id: string,
  itemId: string,
  expect: QueueStep['expect'],
): Graph {
  return mapItems(graph, id, itemId, (q) => {
    if (!('action' in q) || q.expect === expect) return q;
    const step: QueueStep = { ...q };
    if (expect === undefined) delete step.expect;
    else step.expect = expect;
    return step;
  });
}

/** Sets what an if-then checks. */
export function setCondition(graph: Graph, id: string, ifId: string, condition: Condition): Graph {
  return mapItems(graph, id, ifId, (q) =>
    isIf(q) && JSON.stringify(q.if) !== JSON.stringify(condition) ? { ...q, if: condition } : q,
  );
}

/** `list` with the item `itemId` moved to `index` (clamped); `list` itself if that changes nothing. */
function moveTo<T extends { id: string }>(list: T[], itemId: string, index: number): T[] {
  const item = list.find((q) => q.id === itemId);
  if (!item) return list;
  const rest = list.filter((q) => q !== item);
  const at = Math.max(0, Math.min(index, rest.length));
  return rest[at - 1] === list[at - 1] && list[at] === item
    ? list
    : [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** An if-then or a repeat holding `list` (its `key`): itself when that is what it holds. */
function withList<T extends QueueItem, K extends keyof T>(q: T, key: K, list: T[K] & unknown[]): T {
  const before = q[key] as unknown[];
  return list.length === before.length && list.every((item, i) => item === before[i])
    ? q
    : { ...q, [key]: list };
}

/** Whether an item is a step or a message: what acts on, or goes to, an agent. */
function isStep(item: QueueItem): item is QueueStep | QueueMessage {
  return !isIf(item) && !isWait(item) && !isDelay(item) && !isApproval(item) && !isRepeat(item);
}

/**
 * Changes the item `itemId` of a node's queue, wherever it is (at the top, in an if-then or in a
 * repeat), by `change`: an item of the same kind, or the item itself to change nothing.
 */
function mapItems(
  graph: Graph,
  id: string,
  itemId: string,
  change: (item: QueueItem) => QueueItem,
): Graph {
  const one = <T extends QueueItem>(q: T): T => (q.id === itemId ? (change(q) as T) : q);
  return updateQueue(graph, id, (queue) =>
    queue.map((q) => {
      const changed = one(q);
      if (changed !== q) return changed;
      if (isIf(q)) return withList(q, 'then', q.then.map(one));
      if (isRepeat(q)) return withList(q, 'repeat', q.repeat.map(one));
      return q;
    }),
  );
}

function updateQueue(graph: Graph, id: string, update: (queue: QueueItem[]) => QueueItem[]): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return graph;
  const before = node.data.queue ?? [];
  const queue = update(before);
  if (queue.length === before.length && queue.every((item, i) => item === before[i])) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n === node ? { ...n, data: { ...n.data, queue } } : n)),
  };
}

/** Makes node `id` the only selected element. Returns the same graph when it already is. */
export function selectOnly(graph: Graph, id: string): Graph {
  const nodes = graph.nodes.map((n) => select(n, n.id === id));
  const edges = graph.edges.map((e) => select(e, false));
  const unchanged =
    nodes.every((n, i) => n === graph.nodes[i]) && edges.every((e, i) => e === graph.edges[i]);
  return unchanged ? graph : { nodes, edges };
}

/**
 * Whether an edge may be drawn from `source` to `target`: both are agents, and distinct. Drawing one
 * between agents already linked is allowed (it can queue work instead, see work.ts).
 */
export function canConnect(graph: Graph, connection: { source: string; target: string }): boolean {
  const { source, target } = connection;
  const isAgent = (id: string) => graph.nodes.some((n) => n.id === id && n.type === 'agent');
  return source !== target && isAgent(source) && isAgent(target);
}

/**
 * Links two agents so they can talk to each other: an edge with no direction (and no arrowhead),
 * between the dots it was drawn between. The graph's stored edges are these links; the work queues
 * give other agents is drawn from the queues (work.ts). Invalid connections, and agents already
 * linked either way round, are ignored.
 */
export function connect(
  graph: Graph,
  connection: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
): Graph {
  const { source, target, sourceHandle, targetHandle } = connection;
  if (!canConnect(graph, connection) || areLinked(graph.edges, source, target)) return graph;
  const edge: Edge = { id: edgeId(source, target), source, target };
  if (sourceHandle) edge.sourceHandle = sourceHandle;
  if (targetHandle) edge.targetHandle = targetHandle;
  return { ...graph, edges: [...graph.edges, edge] };
}

/** Deletes one edge. */
export function deleteEdge(graph: Graph, id: string): Graph {
  const edges = graph.edges.filter((e) => e.id !== id);
  return edges.length === graph.edges.length ? graph : { ...graph, edges };
}

/**
 * Deletes the selected agents and edges, and every edge attached to a deleted agent. Children of a
 * deleted container are kept: they move to the nearest surviving ancestor (or the top level)
 * without moving on screen. Containers then shrink to fit what is left.
 */
export function deleteSelection(graph: Graph): Graph {
  const removed = new Set(graph.nodes.filter((n) => n.selected).map((n) => n.id));
  const edgesBefore = graph.edges.length;
  const edges = graph.edges.filter(
    (e) => !e.selected && !removed.has(e.source) && !removed.has(e.target),
  );
  if (removed.size === 0 && edges.length === edgesBefore) return graph;
  const byId = indexById(graph.nodes);
  const cleared = clearDeletedReferences(graph.nodes, removed);
  const nodes = cleared.nodes.flatMap((n): GraphNode[] => {
    if (removed.has(n.id)) return [];
    if (n.parentId === undefined || !removed.has(n.parentId)) return [n];
    let ancestor = parentOf(n, byId);
    while (ancestor && removed.has(ancestor.id)) ancestor = parentOf(ancestor, byId);
    const abs = absolutePosition(n, byId);
    const origin = ancestor ? absolutePosition(ancestor, byId) : { x: 0, y: 0 };
    return [
      withParent({ ...n, position: { x: abs.x - origin.x, y: abs.y - origin.y } }, ancestor?.id),
    ];
  });
  return { nodes: autosize(nodes), edges };
}

/**
 * The nodes that grouping would move into a new container: the selected agents that have no
 * selected ancestor (descendants move with their ancestor). Empty when they do not all share the
 * same parent.
 */
export function groupMembers(nodes: readonly GraphNode[]): GraphNode[] {
  const roots = selectionRoots(nodes);
  const [first] = roots;
  return first && roots.every((n) => n.parentId === first.parentId) ? roots : [];
}

/**
 * Moves the group members into a new container of the given kind, sized to fit them, and makes
 * the container the only selected element. The container is created where the members were (top
 * level or inside their shared parent, which grows if needed). Nothing moves on screen.
 */
export function groupSelection(graph: Graph, kind: NodeKind, id: string): Graph {
  const members = groupMembers(graph.nodes);
  if (members.length === 0) return graph;
  const parentId = members[0]?.parentId;
  const { x1, y1 } = bounds(members);
  const position = { x: x1 - PADDING, y: y1 - topInset(kind) };
  const container = withParent(
    {
      id,
      type: kind,
      position,
      data: {
        label: nextLabel(graph.nodes, kind === 'frame' ? 'Group' : 'Agent'),
        color: nextGroupColor(graph.nodes),
        ...(kind === 'agent' ? newAgent(id) : {}),
      },
      selected: true,
    },
    parentId,
  );
  const memberIds = new Set(members.map((n) => n.id));
  const rest = graph.nodes.map((n) =>
    memberIds.has(n.id)
      ? withParent(
          {
            ...n,
            position: { x: n.position.x - position.x, y: n.position.y - position.y },
            selected: false,
          },
          id,
        )
      : select(n, false),
  );
  // Behind its siblings: first among the top-level nodes, or right after its parent.
  const at = parentId === undefined ? 0 : rest.findIndex((n) => n.id === parentId) + 1;
  return {
    nodes: autosize([...rest.slice(0, at), container, ...rest.slice(at)]),
    edges: graph.edges.map((e) => select(e, false)),
  };
}

/**
 * Gives a frame a parent node: the frame becomes an item over the same children, its card centred
 * on the group's top border, and the only selected element. Nothing else moves on screen.
 */
export function addParent(graph: Graph, id: string): Graph {
  const frame = graph.nodes.find((n) => n.id === id);
  if (frame?.type !== 'frame') return graph;
  const label = nextLabel(graph.nodes, 'Agent');
  const nodes = graph.nodes.map((n) =>
    n === frame
      ? {
          ...n,
          type: 'agent' as const,
          data: { ...n.data, label, ...newAgent(n.id) },
          selected: true,
        }
      : select(n, false),
  );
  return { nodes: autosize(nodes), edges: graph.edges.map((e) => select(e, false)) };
}

/**
 * The colour each node shows: a group its own, any other node that of the innermost group it is in.
 * Nodes outside any group have none.
 */
export function groupColors(nodes: readonly GraphNode[]): Map<string, number> {
  const byId = indexById(nodes);
  const parentIds = new Set(nodes.map((n) => n.parentId));
  const colors = new Map<string, number>();
  for (const node of nodes) {
    for (let n: GraphNode | undefined = node; n; n = parentOf(n, byId)) {
      const isGroup = n.type === 'frame' || parentIds.has(n.id);
      if (isGroup && n.data.color !== undefined) {
        colors.set(node.id, n.data.color);
        break;
      }
    }
  }
  return colors;
}

/** The colour for a new group: the one fewest groups have, the first of those on a tie. */
export function nextGroupColor(nodes: readonly GraphNode[]): number {
  const parentIds = new Set(nodes.map((n) => n.parentId));
  const uses = new Array<number>(GROUP_COLORS).fill(0);
  for (const n of nodes) {
    const isGroup = n.type === 'frame' || parentIds.has(n.id);
    if (isGroup && n.data.color !== undefined) {
      const i = n.data.color % GROUP_COLORS;
      uses[i] = (uses[i] ?? 0) + 1;
    }
  }
  return uses.indexOf(Math.min(...uses));
}

/** Whether `ungroupSelection` would change anything. */
export function canUngroup(nodes: readonly GraphNode[]): boolean {
  const parentIds = new Set(nodes.map((n) => n.parentId));
  return selectionRoots(nodes).some(
    (n) => n.type === 'frame' || parentIds.has(n.id) || n.parentId !== undefined,
  );
}

/**
 * For each selected node without a selected ancestor, in array order:
 * - a frame is removed and its children move up one level;
 * - an item with children keeps its edges, its children move up one level, and it goes back to
 *   being a plain node where its card was;
 * - any other node inside a container moves out of it, up one level.
 * Nothing else moves on screen. The nodes that moved become the selection.
 */
export function ungroupSelection(graph: Graph): Graph {
  const parentIds = new Set(graph.nodes.map((n) => n.parentId));
  const roots = selectionRoots(graph.nodes).filter(
    (n) => n.type === 'frame' || parentIds.has(n.id) || n.parentId !== undefined,
  );
  if (roots.length === 0) return graph;
  let nodes = graph.nodes.map((n) => select(n, false));
  for (const root of roots) {
    const byId = indexById(nodes);
    const current = byId.get(root.id);
    if (!current) continue;
    if (current.type === 'frame' || parentIds.has(current.id)) {
      nodes = nodes.flatMap((n): GraphNode[] => {
        if (n.parentId === current.id) return [moveUp(n, current)];
        if (n.id !== current.id) return [n];
        return current.type === 'frame' ? [] : [n];
      });
    } else {
      const parent = parentOf(current, byId);
      if (parent) nodes = nodes.map((n) => (n.id === current.id ? moveUp(n, parent) : n));
    }
  }
  return {
    nodes: autosize(nodes),
    edges: graph.edges.map((e) => select(e, false)),
  };
}

/** Selected nodes that have no selected ancestor, in array order. */
export function selectionRoots(nodes: readonly GraphNode[]): GraphNode[] {
  const byId = indexById(nodes);
  return nodes.filter((n) => {
    if (!n.selected) return false;
    for (let p = parentOf(n, byId); p; p = parentOf(p, byId)) {
      if (p.selected) return false;
    }
    return true;
  });
}

/** Position in flow coordinates: the sum of the positions up the parent chain. */
export function absolutePosition(
  node: GraphNode,
  byId: ReadonlyMap<string, GraphNode>,
): XYPosition {
  let { x, y } = node.position;
  for (let p = parentOf(node, byId); p; p = parentOf(p, byId)) {
    x += p.position.x;
    y += p.position.y;
  }
  return { x, y };
}

/**
 * The innermost container (frame, or item with children) whose box contains `point` (flow
 * coordinates). Among overlapping containers at the same depth the later one, drawn on top, wins.
 */
export function containerAt(nodes: readonly GraphNode[], point: XYPosition): GraphNode | undefined {
  const byId = indexById(nodes);
  const parentIds = new Set(nodes.map((n) => n.parentId));
  let best: { node: GraphNode; depth: number } | undefined;
  for (const node of nodes) {
    if (node.type !== 'frame' && !parentIds.has(node.id)) continue;
    const { x, y } = absolutePosition(node, byId);
    const { width, height } = size(node);
    if (point.x < x || point.x > x + width || point.y < y || point.y > y + height) continue;
    let depth = 0;
    for (let p = parentOf(node, byId); p; p = parentOf(p, byId)) depth++;
    if (!best || depth >= best.depth) best = { node, depth };
  }
  return best?.node;
}

/**
 * Sizes every container to fit its children: PADDING inside its left, right and bottom edges and
 * `topInset` below its top. Containers grow and shrink; a container moves when its children's
 * top-left corner does, and its children move back, so nothing moves on screen. Innermost
 * containers go first, so an outer one fits its inner ones' new boxes. A frame without children
 * becomes EMPTY_FRAME at the same top-left corner; an item without children goes back to its
 * card, centred where the card was. Returns `nodes` itself when nothing changes, and unchanged
 * nodes keep their identity: this runs on every React Flow change, including every drag frame.
 *
 * While a node is being dragged, the containers around it keep their top-left corner and only
 * their right and bottom edges follow; the rest fits when the drag ends. React Flow reports a drag
 * move only when the node's position inside its container changes, so a container that moved
 * along with the node would swallow moves.
 */
export function autosize(nodes: GraphNode[]): GraphNode[] {
  const childIndices = new Map<string, number[]>();
  for (const [i, node] of nodes.entries()) {
    if (node.parentId === undefined) continue;
    const indices = childIndices.get(node.parentId);
    if (indices) indices.push(i);
    else childIndices.set(node.parentId, [i]);
  }
  const byId = indexById(nodes);
  const pinned = new Set<string>();
  for (const node of nodes) {
    if (!node.dragging) continue;
    for (let p = parentOf(node, byId); p; p = parentOf(p, byId)) pinned.add(p.id);
  }
  let result = nodes;
  const set = (i: number, node: GraphNode) => {
    if (result === nodes) result = [...nodes];
    result[i] = node;
  };
  // Children come after their parents, so going backwards reaches each container after everything
  // inside it has its final size.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = result[i];
    if (!node) continue;
    const indices = childIndices.get(node.id);
    if (!indices) {
      const fitted = childless(node);
      if (fitted !== node) set(i, fitted);
      continue;
    }
    const children = indices.map((j) => result[j]).filter((n) => n !== undefined);
    const { x1, y1, x2, y2 } = bounds(children);
    const top = topInset(node.type);
    const dx = pinned.has(node.id) ? 0 : x1 - PADDING;
    const dy = pinned.has(node.id) ? 0 : y1 - top;
    const fit = { width: x2 - dx + PADDING, height: y2 - dy + PADDING };
    if (dx === 0 && dy === 0 && hasSize(node, fit)) continue;
    const position = { x: node.position.x + dx, y: node.position.y + dy };
    set(i, resized({ ...node, position }, fit));
    if (dx === 0 && dy === 0) continue;
    for (const j of indices) {
      const child = result[j];
      if (child)
        set(j, { ...child, position: { x: child.position.x - dx, y: child.position.y - dy } });
    }
  }
  return result;
}

/** Width and height as React Flow sees them: measured, else explicit, else an item's default. */
export function size(node: GraphNode): Size {
  return {
    width: node.measured?.width ?? node.width ?? CARD_SIZE.width,
    height: node.measured?.height ?? node.height ?? CARD_SIZE.height,
  };
}

/**
 * How far below a container's top its children start: past the header zone at the top of its box
 * (a frame's label bar), plus PADDING. A parent node's box starts half a card lower, because its
 * card straddles the box's top border; so a frame that gets a parent keeps its border in place.
 */
export function topInset(kind: NodeKind): number {
  return (kind === 'frame' ? 0 : CARD_SIZE.height / 2) + HEADER + PADDING;
}

/** A node without children: frames shrink to EMPTY_FRAME, items lose their container size. */
function childless(node: GraphNode): GraphNode {
  if (node.type === 'frame') return hasSize(node, EMPTY_FRAME) ? node : resized(node, EMPTY_FRAME);
  if (node.width === undefined) return node;
  // The card was centred on the box's top border; leave the plain node where the card was.
  const shrunk = {
    ...node,
    position: { x: node.position.x + (node.width - CARD_SIZE.width) / 2, y: node.position.y },
  };
  delete shrunk.width;
  delete shrunk.height;
  return shrunk;
}

function hasSize(node: GraphNode, { width, height }: Size): boolean {
  const current = size(node);
  return (
    node.width === width &&
    node.height === height &&
    current.width === width &&
    current.height === height
  );
}

/** Sets an explicit size, and `measured` to match so the node is not hidden until measured. */
function resized<T extends GraphNode>(node: T, { width, height }: Size): T {
  return { ...node, width, height, measured: { width, height } };
}

/** The box around `nodes` (non-empty), in their parent's coordinates. */
export function bounds(nodes: readonly GraphNode[]): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  return {
    x1: Math.min(...nodes.map((n) => n.position.x)),
    y1: Math.min(...nodes.map((n) => n.position.y)),
    x2: Math.max(...nodes.map((n) => n.position.x + size(n).width)),
    y2: Math.max(...nodes.map((n) => n.position.y + size(n).height)),
  };
}

/** Moves `node` out of `parent` into the parent's own parent, keeping it in place on screen. */
function moveUp(node: GraphNode, parent: GraphNode): GraphNode {
  const position = {
    x: node.position.x + parent.position.x,
    y: node.position.y + parent.position.y,
  };
  return withParent({ ...node, position, selected: true }, parent.parentId);
}

function withParent<T extends GraphNode>(node: T, parentId: string | undefined): T {
  const next = { ...node };
  if (parentId === undefined) delete next.parentId;
  else next.parentId = parentId;
  return next;
}

function select<T extends { selected?: boolean }>(element: T, selected: boolean): T {
  return (element.selected ?? false) === selected ? element : { ...element, selected };
}

function indexById(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function parentOf(node: GraphNode, byId: ReadonlyMap<string, GraphNode>): GraphNode | undefined {
  return node.parentId === undefined ? undefined : byId.get(node.parentId);
}

function near(a: XYPosition, b: XYPosition): boolean {
  return Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4;
}
