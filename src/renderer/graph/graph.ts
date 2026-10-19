import type { Edge, Node, XYPosition } from '@xyflow/react';

import type { AdapterId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, CanvasDocument, CanvasNode } from '../../shared/model/canvas';
import { size as modelSize } from '../../shared/model/geometry';
import { autosize, size } from './geometry';
import * as Structure from '../../shared/model/structure';
import type { AgentSettingsChange } from '../../shared/session';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from './agents';
import type { AgentConnection } from './agents';
import { isIf, isRepeat } from '../../shared/model/queue';
import type {
  Condition,
  QueueChange,
  QueueEntry,
  QueueRepeat,
  QueueStep,
  Time,
  WaitTarget,
} from '../../shared/model/queue';
import * as QueueOps from '../../shared/model/queue-ops';
import * as AgentOps from '../../shared/model/agent-ops';

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

export function setAgent(graph: Graph, agent: string, adapter: AdapterId): Graph {
  return structureEdit(
    graph,
    (doc) =>
      AgentOps.setType(
        doc,
        { agent, adapter },
        { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
      ),
    { fit: false },
  );
}
export function setConnection(graph: Graph, agent: string, connection: AgentConnection): Graph {
  return structureEdit(
    graph,
    (doc) =>
      AgentOps.setConnection(
        doc,
        { agent, connection },
        { catalog: catalog(), defaultAdapter: DEFAULT_AGENT },
      ),
    { fit: false },
  );
}
export function setSettings(
  graph: Graph,
  agent: string,
  adapter: AdapterId,
  change: AgentSettingsChange,
): Graph {
  return structureEdit(graph, (doc) => AgentOps.setSettings(doc, { agent, adapter, change }), {
    fit: false,
  });
}
export function setRole(graph: Graph, agent: string, role: string | undefined): Graph {
  return structureEdit(graph, (doc) => AgentOps.setRole(doc, { agent, role }), { fit: false });
}

export function addToQueue(
  graph: Graph,
  agent: string,
  entry: QueueEntry,
  newId: () => string,
  into?: string,
): Graph {
  return structureEdit(
    graph,
    (doc) =>
      QueueOps.add(doc, { agent, entry, ...(into === undefined ? {} : { into }) }, 'you', newId),
    { fit: false },
  );
}
export function removeFromQueue(graph: Graph, agent: string, item: string): Graph {
  return structureEdit(graph, (doc) => QueueOps.remove(doc, { agent, item }), { fit: false });
}

/** The view still supplies a drop index; the model moves by a sibling's id. */
export function moveInQueue(graph: Graph, agent: string, item: string, index: number): Graph {
  const queue = graph.nodes.find((node) => node.id === agent)?.data.queue ?? [];
  const container = queue.find((one) =>
    isIf(one)
      ? one.then.some((inner) => inner.id === item)
      : isRepeat(one) && one.repeat.some((inner) => inner.id === item),
  );
  const siblings = queue.some((one) => one.id === item)
    ? queue
    : container && isIf(container)
      ? container.then
      : container && isRepeat(container)
        ? container.repeat
        : [];
  const rest = siblings.filter((one) => one.id !== item);
  const before = rest[Math.max(0, index)]?.id ?? null;
  return structureEdit(graph, (doc) => QueueOps.move(doc, { agent, item, before }), { fit: false });
}
function queueChange(graph: Graph, agent: string, item: string, change: QueueChange): Graph {
  return structureEdit(graph, (doc) => QueueOps.update(doc, { agent, item, change }, 'you'), {
    fit: false,
  });
}
export function retarget(
  graph: Graph,
  agent: string,
  item: string,
  target: string | undefined,
): Graph {
  return queueChange(graph, agent, item, { kind: 'target', target: target ?? null });
}
export function editMessage(graph: Graph, agent: string, item: string, message: string): Graph {
  return queueChange(graph, agent, item, { kind: 'message', message });
}
export function setAction(graph: Graph, agent: string, item: string, action: string): Graph {
  return queueChange(graph, agent, item, { kind: 'action', action });
}
export function setInstruction(
  graph: Graph,
  agent: string,
  item: string,
  instruction: string,
): Graph {
  return queueChange(graph, agent, item, { kind: 'instruction', instruction });
}
export function setExpect(
  graph: Graph,
  agent: string,
  item: string,
  expect: QueueStep['expect'],
): Graph {
  return queueChange(graph, agent, item, { kind: 'expect', expect: expect ?? null });
}
export function setCondition(
  graph: Graph,
  agent: string,
  item: string,
  condition: Condition,
): Graph {
  return queueChange(graph, agent, item, { kind: 'condition', condition });
}
export function setWaitFor(
  graph: Graph,
  agent: string,
  item: string,
  waitFor: WaitTarget[],
): Graph {
  return queueChange(graph, agent, item, { kind: 'waitFor', waitFor });
}
export function setTime(graph: Graph, agent: string, item: string, time: Time | undefined): Graph {
  return queueChange(graph, agent, item, { kind: 'time', time: time ?? null });
}
export function setApproval(graph: Graph, agent: string, item: string, approve: string): Graph {
  return queueChange(graph, agent, item, { kind: 'approve', approve });
}
export function setRepeat(
  graph: Graph,
  agent: string,
  item: string,
  change: Partial<Pick<QueueRepeat, 'until' | 'rounds' | 'otherwise'>>,
): Graph {
  return queueChange(graph, agent, item, { kind: 'repeat', ...change });
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
