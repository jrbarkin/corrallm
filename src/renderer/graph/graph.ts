import type { Edge, Node, XYPosition } from '@xyflow/react';

import { DEFAULT_AGENT } from './agents';
import type { AgentType } from './agents';
import { isIf, isMessage } from './queue';
import type { Condition, QueueItem, QueueMessage, Question, QueueStep } from './queue';

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
 * `agent`: the coding agent an item runs (frames have none). `color`: a group's colour, an index
 * into the GROUP_COLORS palette (GraphEditor.css).
 */
export type GraphNode = Node<
  {
    label: string;
    agent?: AgentType;
    queue?: QueueItem[];
    questions?: Question[];
    color?: number;
  },
  NodeKind
>;
export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
/** An item's card: 150px wide, a 32px label inside a 1px border. Matches `.graph-card`. */
export const CARD_SIZE = { width: 150, height: 34 } as const;
/** Height of a container's header zone (a frame's label bar). Matches `.graph-label` in GraphEditor.css. */
export const HEADER = 32;
/** Space between a container's edges (below its label bar or card) and its children. */
export const PADDING = 20;
/** A frame without children: room for one item. */
export const EMPTY_FRAME = {
  width: CARD_SIZE.width + 2 * PADDING,
  height: HEADER + 2 * PADDING,
} as const;
/** How many colours groups take turns with (`.group-color-0` … in GraphEditor.css). */
export const GROUP_COLORS = 8;
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
 * What a new agent (node `id`) starts with besides its label: the default agent, and a queue that
 * starts with a message to write, telling the agent what to do.
 */
function newAgent(id: string): Pick<GraphNode['data'], 'agent' | 'queue'> {
  return { agent: DEFAULT_AGENT, queue: [{ id: `${id}/message`, message: '' }] };
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

/** Sets the coding agent a node runs. Groups (frames) have none. */
export function setAgent(graph: Graph, id: string, agent: AgentType): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.type !== 'agent' || node.data.agent === agent) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n === node ? { ...n, data: { ...n.data, agent } } : n)),
  };
}

/**
 * Appends an item to a node's queue, or with `into` (an if-then's id) a step to that if-then's
 * steps. If-thens do not nest.
 */
export function addToQueue(graph: Graph, id: string, item: QueueItem, into?: string): Graph {
  return updateQueue(graph, id, (queue) => {
    if (into === undefined) return [...queue, item];
    if (isIf(item)) return queue;
    return queue.map((q) => (q.id === into && isIf(q) ? { ...q, then: [...q.then, item] } : q));
  });
}

/** Removes one item from a node's queue, or one step from an if-then in it. */
export function removeFromQueue(graph: Graph, id: string, itemId: string): Graph {
  return updateQueue(graph, id, (queue) =>
    queue
      .filter((q) => q.id !== itemId)
      .map((q) =>
        isIf(q) && q.then.some((step) => step.id === itemId)
          ? { ...q, then: q.then.filter((step) => step.id !== itemId) }
          : q,
      ),
  );
}

/** Moves an item to `index` in its list (the queue, or an if-then's steps), clamped to its ends. */
export function moveInQueue(graph: Graph, id: string, itemId: string, index: number): Graph {
  return updateQueue(graph, id, (queue) =>
    queue.some((q) => q.id === itemId)
      ? moveTo(queue, itemId, index)
      : queue.map((q) => (isIf(q) ? withSteps(q, moveTo(q.then, itemId, index)) : q)),
  );
}

/** Sets which node a step acts on; `undefined` makes it act on the node whose queue it is in. */
export function retarget(
  graph: Graph,
  id: string,
  itemId: string,
  target: string | undefined,
): Graph {
  const aim = (step: QueueStep | QueueMessage): QueueStep | QueueMessage => {
    if (step.id !== itemId || isMessage(step) || step.target === target) return step;
    const next = { ...step };
    if (target === undefined) delete next.target;
    else next.target = target;
    return next;
  };
  return updateQueue(graph, id, (queue) =>
    queue.map((q) => (isIf(q) ? withSteps(q, q.then.map(aim)) : aim(q))),
  );
}

/** Changes the text of a message in the queue (or in an if-then in it). */
export function editMessage(graph: Graph, id: string, itemId: string, message: string): Graph {
  const edit = <T extends QueueItem>(q: T): T =>
    q.id === itemId && isMessage(q) && q.message !== message ? { ...q, message } : q;
  return updateQueue(graph, id, (queue) =>
    queue.map((q) => (isIf(q) ? withSteps(q, q.then.map(edit)) : edit(q))),
  );
}

/** Adds a question an agent asks the user. */
export function askUser(graph: Graph, id: string, question: Question): Graph {
  return updateQuestions(graph, id, (questions) => [...questions, question]);
}

/** Records the user's answer to an agent's question. */
export function answerQuestion(
  graph: Graph,
  id: string,
  questionId: string,
  answer: string,
): Graph {
  return updateQuestions(graph, id, (questions) =>
    questions.map((q) => (q.id === questionId ? { ...q, answer } : q)),
  );
}

/** The questions agents are waiting on, in graph order: each with the agent that asked it. */
export function pendingQuestions(
  nodes: readonly GraphNode[],
): { agent: GraphNode; question: Question }[] {
  return nodes.flatMap((agent) =>
    (agent.data.questions ?? [])
      .filter((question) => question.answer === undefined)
      .map((question) => ({ agent, question })),
  );
}

function updateQuestions(
  graph: Graph,
  id: string,
  update: (questions: Question[]) => Question[],
): Graph {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return graph;
  const before = node.data.questions ?? [];
  const questions = update(before);
  if (questions.length === before.length && questions.every((q, i) => q === before[i]))
    return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n === node ? { ...n, data: { ...n.data, questions } } : n)),
  };
}

/** Sets what an if-then checks. */
export function setCondition(graph: Graph, id: string, ifId: string, condition: Condition): Graph {
  return updateQueue(graph, id, (queue) =>
    queue.map((q) => (q.id === ifId && isIf(q) ? { ...q, if: condition } : q)),
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

/** An if-then with these steps: itself when they are the same steps. */
function withSteps<T extends { then: (QueueStep | QueueMessage)[] }>(
  q: T,
  then: (QueueStep | QueueMessage)[],
): T {
  return then.length === q.then.length && then.every((step, i) => step === q.then[i])
    ? q
    : { ...q, then };
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

/** Whether agents `a` and `b` are linked (can talk to each other), whichever way it was drawn. */
export function areLinked(graph: Graph, a: string, b: string): boolean {
  return graph.edges.some(
    (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a),
  );
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
  if (!canConnect(graph, connection) || areLinked(graph, source, target)) return graph;
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
  const nodes = graph.nodes.flatMap((n): GraphNode[] => {
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
function nextGroupColor(nodes: readonly GraphNode[]): number {
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
function bounds(nodes: readonly GraphNode[]): { x1: number; y1: number; x2: number; y2: number } {
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
