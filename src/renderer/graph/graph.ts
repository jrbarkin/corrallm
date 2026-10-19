import type { Edge, Node, XYPosition } from '@xyflow/react';

import { isStartMode } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, CanvasDocument, CanvasNode } from '../../shared/model/canvas';
import { size as modelSize } from '../../shared/model/geometry';
import { autosize, size } from './geometry';
import * as Structure from '../../shared/model/structure';
import { parseRole } from '../../shared/role';
import { mergeAgentSettings } from '../../shared/session';
import type { AgentSettingsChange } from '../../shared/session';
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
  /** The canvas's saved automatic layout setting; absent is off. */
  arrange?: boolean;
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
export function graphOf({ arrange, nodes, links }: CanvasDocument): Graph {
  return {
    ...(arrange ? { arrange: true } : {}),
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
    arrange: graph.arrange ?? false,
    nodes: canvasNodes(graph.nodes),
    links: graph.edges.map(({ source, target, sourceHandle, targetHandle }) => ({
      source,
      target,
      ...(sourceHandle && targetHandle ? { dots: [sourceHandle, targetHandle] } : {}),
    })),
  };
}

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
export { NODE_GAP, RANK_GAP } from '../../shared/model/structure';

export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

export function nextLabel(nodes: readonly GraphNode[], prefix: 'Agent' | 'Group'): string {
  return Structure.nextLabel(canvasNodes(nodes), prefix);
}

export function addAgent(graph: Graph, id: string, center: XYPosition): Graph {
  return structureEdit(
    graph,
    (doc, context) => Structure.addAgent(doc, { at: center, adapter: DEFAULT_AGENT }, context),
    { newId: nodeIds(id) },
  );
}

export function spawnAgent(
  graph: Graph,
  from: string,
  id: string,
  relation: 'peer' | 'linked',
): Graph {
  return structureEdit(
    graph,
    (doc, context) => Structure.spawnAgent(doc, { from, relation }, context),
    { newId: nodeIds(id) },
  );
}

export function renameNode(graph: Graph, id: string, label: string): Graph {
  return structureEdit(graph, (doc) => Structure.rename(doc, { id, label }), { fit: false });
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
  const kept = mergeAgentSettings(settings, adapter, { mode: null });
  return kept === undefined ? {} : { settings: kept };
}

/** `graph` with `node`'s data replaced by `data`. */
function replace(graph: Graph, node: GraphNode, data: GraphNode['data']): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n === node ? { ...n, data } : n)) };
}

/**
 * Merges what an agent is set to run with by `adapter`: omitted fields stay, null unsets them.
 * Nothing set by any adapter leaves it no settings at all.
 */
export function setSettings(
  graph: Graph,
  id: string,
  adapter: AdapterId,
  change: AgentSettingsChange,
): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.type !== 'agent') return graph;
  const { settings: before, ...data } = node.data;
  const kept = mergeAgentSettings(before, adapter, change);
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

export function canConnect(graph: Graph, connection: { source: string; target: string }): boolean {
  return Structure.canLink({ nodes: canvasNodes(graph.nodes) }, connection);
}

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
  const next = structureEdit(
    graph,
    (doc) =>
      Structure.link(doc, {
        source,
        target,
        ...(sourceHandle && targetHandle ? { dots: [sourceHandle, targetHandle] } : {}),
      }),
    { fit: false },
  );
  if (next === graph || (sourceHandle && targetHandle)) return next;
  return {
    ...next,
    edges: next.edges.map((edge) =>
      edge.id === edgeId(source, target)
        ? {
            ...edge,
            ...(sourceHandle ? { sourceHandle } : {}),
            ...(targetHandle ? { targetHandle } : {}),
          }
        : edge,
    ),
  };
}

export function deleteEdge(graph: Graph, id: string): Graph {
  const edge = graph.edges.find((edge) => edge.id === id);
  return edge ? structureEdit(graph, (doc) => Structure.unlink(doc, edge), { fit: false }) : graph;
}

export function deleteSelection(graph: Graph): Graph {
  return structureEdit(graph, (doc, context) =>
    Structure.remove(
      doc,
      {
        nodes: graph.nodes.filter((node) => node.selected).map((node) => node.id),
        links: graph.edges
          .filter((edge) => edge.selected)
          .map(({ source, target }) => ({ source, target })),
      },
      context,
    ),
  );
}

export function groupMembers(nodes: readonly GraphNode[]): GraphNode[] {
  const members = new Set(
    Structure.groupMembers(canvasNodes(nodes), selectedNodeIds(nodes)).map((node) => node.id),
  );
  return nodes.filter((node) => members.has(node.id));
}

export function groupSelection(graph: Graph, kind: NodeKind, id: string): Graph {
  return structureEdit(
    graph,
    (doc, context) => Structure.group(doc, { nodes: selectedNodeIds(graph.nodes), kind }, context),
    { newId: nodeIds(id) },
  );
}

export function addParent(graph: Graph, id: string): Graph {
  return structureEdit(graph, (doc, context) => Structure.addParent(doc, { id }, context), {
    newId: () => `${id}/message`,
  });
}

export function canUngroup(nodes: readonly GraphNode[]): boolean {
  return Structure.canUngroup(canvasNodes(nodes), selectedNodeIds(nodes));
}

export function ungroupSelection(graph: Graph): Graph {
  return structureEdit(graph, (doc, context) =>
    Structure.ungroup(doc, { nodes: selectedNodeIds(graph.nodes) }, context),
  );
}

export function selectionRoots(nodes: readonly GraphNode[]): GraphNode[] {
  const roots = new Set(
    Structure.roots(canvasNodes(nodes), selectedNodeIds(nodes)).map((node) => node.id),
  );
  return nodes.filter((node) => roots.has(node.id));
}

function selectedNodeIds(nodes: readonly GraphNode[]): string[] {
  return nodes.filter((node) => node.selected).map((node) => node.id);
}

function select<T extends { selected?: boolean }>(element: T, selected: boolean): T {
  return (element.selected ?? false) === selected ? element : { ...element, selected };
}

/** Runs a model edit while preserving React Flow's view state and existing box measurements. */
function structureEdit<R>(
  graph: Graph,
  build: (doc: CanvasDocument, context: Structure.StructureContext) => Structure.Built<R>,
  options: { newId?: () => string; fit?: boolean } = {},
): Graph {
  const projected = canvasNodes(graph.nodes).map((node, i): CanvasNode => {
    const view = graph.nodes[i];
    return {
      ...node,
      position: view?.position ?? node.position,
      ...(view?.width === undefined ? {} : { width: view.width }),
      ...(view?.height === undefined ? {} : { height: view.height }),
    };
  });
  const links = graph.edges.map(({ source, target, sourceHandle, targetHandle }) => ({
    source,
    target,
    ...(sourceHandle && targetHandle
      ? { dots: [sourceHandle, targetHandle] as [string, string] }
      : {}),
  }));
  // These edits never read identity; the window keeps its canvas id until the generated ops take over.
  const doc: CanvasDocument = {
    id: '00000000-0000-0000-0000-000000000000' as CanvasId,
    arrange: graph.arrange ?? false,
    nodes: projected,
    links,
  };
  const dimensions = new Map(graph.nodes.map((node) => [node.id, size(node)]));
  const changed = build(doc, {
    newId:
      options.newId ??
      (() => {
        throw new Error('This edit creates no ids.');
      }),
    defaultAdapter: DEFAULT_AGENT,
    sizing: {
      size: (node) => dimensions.get(node.id) ?? modelSize(node),
      resize: (node, box) => {
        dimensions.set(node.id, box);
        return { ...node, ...box };
      },
    },
  });
  if (changed.next === doc) return graph;
  const result = changed.result as { select?: readonly string[] };
  const selection = result.select === undefined ? undefined : new Set(result.select);
  const before = new Map(projected.map((node, i) => [node.id, { node, view: graph.nodes[i] }]));
  const nodes = changed.next.nodes.map((node): GraphNode => {
    const old = before.get(node.id);
    let next: GraphNode;
    if (old?.node === node && old.view) next = old.view;
    else {
      next = {
        ...old?.view,
        id: node.id,
        type: node.type,
        position: node.position,
        data: node.data,
      };
      if (options.fit !== false) {
        delete next.width;
        delete next.height;
      }
      if (node.parentId === undefined) delete next.parentId;
      else next.parentId = node.parentId;
    }
    return selection === undefined ? next : select(next, selection.has(node.id));
  });
  const edges = changed.next.links.map((link): Edge => {
    const index = links.indexOf(link);
    const old = graph.edges[index];
    const next = old ?? {
      id: edgeId(link.source, link.target),
      source: link.source,
      target: link.target,
      ...(link.dots ? { sourceHandle: link.dots[0], targetHandle: link.dots[1] } : {}),
    };
    return selection === undefined ? next : select(next, false);
  });
  const fitted = options.fit === false ? nodes : autosize(nodes);
  return {
    ...graph,
    nodes:
      fitted.length === graph.nodes.length && fitted.every((node, i) => node === graph.nodes[i])
        ? graph.nodes
        : fitted,
    edges:
      edges.length === graph.edges.length && edges.every((edge, i) => edge === graph.edges[i])
        ? graph.edges
        : edges,
  };
}

/** The renderer already chose a node id; the model also asks for its initial message's id. */
function nodeIds(id: string): () => string {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return id;
    }
    return `${id}/message`;
  };
}
