import type { AdapterId } from '../adapter';
import type { AgentData, CanvasDocument, CanvasNode, Link, Position } from './canvas';
import {
  absolutePosition,
  autosize,
  bounds,
  CARD_SIZE,
  containerAt,
  nextGroupColor,
  PADDING,
  size,
  topInset,
} from './geometry';
import type { GeometryNode, Sizing } from './geometry';
import { areLinked } from './queries';
import { clearDeletedReferences } from './references';

/** The next document, and the operation's value and optional selection hint for its view. */
export interface Built<R = { select?: string[] }> {
  next: CanvasDocument;
  result: R;
}

export interface Created {
  id?: string;
  select?: string[];
}

/** The caller supplies ids and the default adapter; a view may supply its box sizes. */
export interface StructureContext {
  newId: () => string;
  defaultAdapter: AdapterId;
  sizing?: Sizing<CanvasNode>;
}

export const NODE_GAP = 40;
export const RANK_GAP = 60;
const NUDGE = 24;

type Ends = Pick<Link, 'source' | 'target'>;
type Geometry = Pick<StructureContext, 'sizing'>;

/** One more than the largest N already used with that label prefix. */
export function nextLabel(nodes: readonly CanvasNode[], prefix: 'Agent' | 'Group'): string {
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  let max = 0;
  for (const node of nodes) {
    const n = pattern.exec(node.data.label)?.[1];
    if (n !== undefined) max = Math.max(max, Number(n));
  }
  return `${prefix} ${String(max + 1)}`;
}

/** Adds an agent centred on a canvas point, inside its innermost container, nudging collisions. */
export function addAgent(
  doc: CanvasDocument,
  { at, adapter }: { at: Position; adapter: AdapterId },
  context: StructureContext,
): Built<Created> {
  const nodes = boxes(doc.nodes, context);
  const byId = indexById(nodes);
  let topLeft = {
    x: Math.round(at.x - CARD_SIZE.width / 2),
    y: Math.round(at.y - CARD_SIZE.height / 2),
  };
  const corners = nodes.map((node) => absolutePosition(node, byId));
  for (let i = 0; i < 50 && corners.some((corner) => near(corner, topLeft)); i++) {
    topLeft = { x: topLeft.x + NUDGE, y: topLeft.y + NUDGE };
  }
  const container = containerAt(
    nodes,
    {
      x: topLeft.x + CARD_SIZE.width / 2,
      y: topLeft.y + CARD_SIZE.height / 2,
    },
    (node) => context.sizing?.size(node) ?? size(node),
  );
  const origin = container ? absolutePosition(container, byId) : { x: 0, y: 0 };
  const id = context.newId();
  const node: CanvasNode = withParent(
    {
      id,
      type: 'agent',
      position: { x: topLeft.x - origin.x, y: topLeft.y - origin.y },
      data: { label: nextLabel(nodes, 'Agent'), ...newAgent(adapter, context.newId) },
    },
    container?.id,
  );
  return fitDocument(doc, [...nodes, node], doc.links, { id, select: [id] }, context);
}

/** Spawns a fresh queue beside or below an agent, keeping its startup choices and role. */
export function spawnAgent(
  doc: CanvasDocument,
  { from, relation }: { from: string; relation: 'peer' | 'linked' },
  context: StructureContext,
): Built<Created> {
  const nodes = boxes(doc.nodes, context);
  const source = nodes.find((node) => node.id === from);
  if (source?.type !== 'agent') return { next: doc, result: {} };
  const byId = indexById(nodes);
  const parentIds = new Set(nodes.map((node) => node.parentId));
  const footprint = (node: CanvasNode) => {
    const { x, y } = absolutePosition(node, byId);
    const { width, height } = context.sizing?.size(node) ?? size(node);
    const card = node.type === 'agent' && parentIds.has(node.id) ? CARD_SIZE.height / 2 : 0;
    return { x, y: y - card, width, height: height + card };
  };
  const ancestors = new Set<string>();
  for (let parent = parentOf(source, byId); parent; parent = parentOf(parent, byId))
    ancestors.add(parent.id);
  const others = nodes.filter((node) => !ancestors.has(node.id)).map(footprint);
  const inTheWay = (x: number, y: number) =>
    others.find(
      (other) =>
        x < other.x + other.width + NODE_GAP &&
        other.x < x + CARD_SIZE.width + NODE_GAP &&
        y < other.y + other.height + PADDING &&
        other.y < y + CARD_SIZE.height + PADDING,
    );
  const at = footprint(source);
  const spot =
    relation === 'peer'
      ? { x: at.x + at.width + NODE_GAP, y: at.y }
      : { x: at.x, y: at.y + at.height + RANK_GAP };
  for (let other = inTheWay(spot.x, spot.y); other; other = inTheWay(spot.x, spot.y)) {
    spot.x = other.x + other.width + NODE_GAP;
  }
  const parent = parentOf(source, byId);
  const origin = parent ? absolutePosition(parent, byId) : { x: 0, y: 0 };
  const id = context.newId();
  const node: CanvasNode = withParent(
    {
      id,
      type: 'agent',
      position: { x: spot.x - origin.x, y: spot.y - origin.y },
      data: {
        label: nextLabel(nodes, 'Agent'),
        ...newAgent(source.data.adapter ?? context.defaultAdapter, context.newId),
        ...(source.data.connection === undefined ? {} : { connection: source.data.connection }),
        ...(source.data.settings === undefined ? {} : { settings: source.data.settings }),
        // An exact copy of the chain and handoff settings you gave its source (B11a C1, R11).
        ...(source.data.fallback === undefined ? {} : { fallback: source.data.fallback }),
        ...(source.data.handoff === undefined ? {} : { handoff: source.data.handoff }),
        ...(source.data.role === undefined ? {} : { role: source.data.role }),
      },
    },
    parent?.id,
  );
  const links =
    relation === 'linked'
      ? [...doc.links, { source: from, target: id, dots: ['bottom', 'top'] as [string, string] }]
      : doc.links;
  return fitDocument(doc, [...nodes, node], links, { id, select: [id] }, context);
}

/** Renames a node without touching its other data or any other entity. */
export function rename(doc: CanvasDocument, { id, label }: { id: string; label: string }): Built {
  const node = doc.nodes.find((node) => node.id === id);
  if (!node || node.data.label === label) return { next: doc, result: {} };
  return {
    next: {
      ...doc,
      nodes: doc.nodes.map((one) =>
        one === node ? { ...one, data: { ...one.data, label } } : one,
      ),
    },
    result: {},
  };
}

export function canLink(doc: Pick<CanvasDocument, 'nodes'>, { source, target }: Ends): boolean {
  const isAgent = (id: string) => doc.nodes.some((node) => node.id === id && node.type === 'agent');
  return source !== target && isAgent(source) && isAgent(target);
}

/** Links distinct agents once, whichever direction the existing link was drawn in. */
export function link(doc: CanvasDocument, connection: Link): Built {
  if (!canLink(doc, connection) || areLinked(doc.links, connection.source, connection.target)) {
    return { next: doc, result: {} };
  }
  return { next: { ...doc, links: [...doc.links, connection] }, result: {} };
}

/** Removes a link by its ends, looking in the reverse direction if it was drawn that way. */
export function unlink(doc: CanvasDocument, ends: Ends): Built {
  const found =
    doc.links.find((link) => sameEnds(link, ends)) ??
    doc.links.find((link) => sameEnds(link, { source: ends.target, target: ends.source }));
  if (!found) return { next: doc, result: {} };
  return {
    next: { ...doc, links: doc.links.filter((link) => !sameEnds(link, found)) },
    result: {},
  };
}

/** Removes nodes and undirected links, keeping children in place and clearing surviving references. */
export function remove(
  doc: CanvasDocument,
  { nodes: ids = [], links: ends = [] }: { nodes?: readonly string[]; links?: readonly Ends[] },
  geometry: Geometry = {},
): Built<{ cleared: string[] }> {
  const removed = new Set(doc.nodes.filter((node) => ids.includes(node.id)).map((node) => node.id));
  const links = doc.links.filter(
    (link) =>
      !removed.has(link.source) &&
      !removed.has(link.target) &&
      !ends.some(
        (end) => sameEnds(link, end) || sameEnds(link, { source: end.target, target: end.source }),
      ),
  );
  if (removed.size === 0)
    return links.length === doc.links.length
      ? { next: doc, result: { cleared: [] } }
      : { next: { ...doc, links }, result: { cleared: [] } };
  const original = boxes(doc.nodes, geometry);
  const byId = indexById(original);
  const cleared = clearDeletedReferences(original, removed);
  const nodes = cleared.nodes.flatMap((node): CanvasNode[] => {
    if (removed.has(node.id)) return [];
    if (node.parentId === undefined || !removed.has(node.parentId)) return [node];
    let ancestor = parentOf(node, byId);
    while (ancestor && removed.has(ancestor.id)) ancestor = parentOf(ancestor, byId);
    const absolute = absolutePosition(node, byId);
    const origin = ancestor ? absolutePosition(ancestor, byId) : { x: 0, y: 0 };
    return [
      withParent(
        { ...node, position: { x: absolute.x - origin.x, y: absolute.y - origin.y } },
        ancestor?.id,
      ),
    ];
  });
  return fitDocument(doc, nodes, links, { cleared: cleared.cleared }, geometry);
}

/** The named nodes without a named ancestor, in document order. */
export function roots(nodes: readonly CanvasNode[], ids: readonly string[]): CanvasNode[] {
  const named = new Set(ids);
  const byId = indexById(nodes);
  return nodes.filter((node) => {
    if (!named.has(node.id)) return false;
    for (let parent = parentOf(node, byId); parent; parent = parentOf(parent, byId)) {
      if (named.has(parent.id)) return false;
    }
    return true;
  });
}

/** Nodes that may share a new parent: outermost named nodes, all in the same container. */
export function groupMembers(nodes: readonly CanvasNode[], ids: readonly string[]): CanvasNode[] {
  const members = roots(nodes, ids);
  const [first] = members;
  return first && members.every((node) => node.parentId === first.parentId) ? members : [];
}

/** Groups explicit nodes, preserving their absolute positions. */
export function group(
  doc: CanvasDocument,
  { nodes: ids, kind }: { nodes: readonly string[]; kind: CanvasNode['type'] },
  context: StructureContext,
): Built<Created> {
  const nodes = boxes(doc.nodes, context);
  const members = groupMembers(nodes, ids);
  if (members.length === 0) return { next: doc, result: {} };
  const parentId = members[0]?.parentId;
  const { x1, y1 } = bounds(members, (node) => context.sizing?.size(node) ?? size(node));
  const position = { x: x1 - PADDING, y: y1 - topInset(kind) };
  const id = context.newId();
  const container: CanvasNode =
    kind === 'frame'
      ? withParent(
          {
            id,
            type: 'frame',
            position,
            data: { label: nextLabel(nodes, 'Group'), color: nextGroupColor(nodes) },
          },
          parentId,
        )
      : withParent(
          {
            id,
            type: 'agent',
            position,
            data: {
              label: nextLabel(nodes, 'Agent'),
              color: nextGroupColor(nodes),
              ...newAgent(context.defaultAdapter, context.newId),
            },
          },
          parentId,
        );
  const memberIds = new Set(members.map((node) => node.id));
  const rest = nodes.map((node) =>
    memberIds.has(node.id)
      ? withParent(
          {
            ...node,
            position: { x: node.position.x - position.x, y: node.position.y - position.y },
          },
          id,
        )
      : node,
  );
  const at = parentId === undefined ? 0 : rest.findIndex((node) => node.id === parentId) + 1;
  return fitDocument(
    doc,
    [...rest.slice(0, at), container, ...rest.slice(at)],
    doc.links,
    { id, select: [id] },
    context,
  );
}

/** Turns a frame into an agent parent, keeping its existing id and children. */
export function addParent(
  doc: CanvasDocument,
  { id }: { id: string },
  context: StructureContext,
): Built<Created> {
  const original = boxes(doc.nodes, context);
  const frame = original.find((node) => node.id === id);
  if (frame?.type !== 'frame') return { next: doc, result: {} };
  const nodes = original.map((node): CanvasNode =>
    node === frame
      ? {
          ...frame,
          type: 'agent',
          data: {
            ...frame.data,
            label: nextLabel(doc.nodes, 'Agent'),
            ...newAgent(context.defaultAdapter, context.newId),
          },
        }
      : node,
  );
  return fitDocument(doc, nodes, doc.links, { id, select: [id] }, context);
}

export function canUngroup(nodes: readonly CanvasNode[], ids: readonly string[]): boolean {
  const parents = new Set(nodes.map((node) => node.parentId));
  return roots(nodes, ids).some(
    (node) => node.type === 'frame' || parents.has(node.id) || node.parentId !== undefined,
  );
}

/** Ungroups outermost named nodes in order, moving their children up without moving on canvas. */
export function ungroup(
  doc: CanvasDocument,
  { nodes: ids }: { nodes: readonly string[] },
  geometry: Geometry = {},
): Built {
  const original = boxes(doc.nodes, geometry);
  const parents = new Set(original.map((node) => node.parentId));
  const named = roots(original, ids).filter(
    (node) => node.type === 'frame' || parents.has(node.id) || node.parentId !== undefined,
  );
  if (named.length === 0) return { next: doc, result: {} };
  let nodes = original;
  const select: string[] = [];
  for (const root of named) {
    const byId = indexById(nodes);
    const current = byId.get(root.id);
    if (!current) continue;
    if (current.type === 'frame' || parents.has(current.id)) {
      nodes = nodes.flatMap((node): CanvasNode[] => {
        if (node.parentId === current.id) {
          select.push(node.id);
          return [moveUp(node, current)];
        }
        return node.id !== current.id || current.type !== 'frame' ? [node] : [];
      });
    } else {
      const parent = parentOf(current, byId);
      if (parent) {
        nodes = nodes.map((node) => (node === current ? moveUp(node, parent) : node));
        select.push(current.id);
      }
    }
  }
  return fitDocument(doc, nodes, doc.links, { select }, geometry);
}

/** Moves named nodes in their parent's coordinates, fitting their groups once after all moves. */
export function move(
  doc: CanvasDocument,
  { moves }: { moves: readonly { node: string; position: Position }[] },
  geometry: Geometry = {},
): Built {
  const byId = new Map(moves.map((move) => [move.node, move.position]));
  const nodes = doc.nodes.map((node) => {
    const position = byId.get(node.id);
    return !position || samePosition(position, node.position) ? node : { ...node, position };
  });
  return nodes.every((node, i) => node === doc.nodes[i])
    ? { next: doc, result: {} }
    : fitDocument(doc, nodes, doc.links, {}, geometry);
}

function newAgent(adapter: AdapterId, newId: () => string): Pick<AgentData, 'adapter' | 'queue'> {
  return { adapter, queue: [{ id: newId(), message: '' }] };
}

/** Model boxes are derived; a view that already sized its nodes supplies its own sizing. */
function boxes(nodes: CanvasNode[], geometry: Geometry): CanvasNode[] {
  return geometry.sizing ? nodes : autosize(nodes);
}

/** Discards computed box fields and preserves every unchanged model object and array. */
export function fitDocument<R>(
  doc: CanvasDocument,
  nodes: CanvasNode[],
  links: Link[],
  result: R,
  geometry: Geometry,
): Built<R> {
  const before = indexById(doc.nodes);
  const fitted = autosize(nodes, geometry);
  const plain = fitted.map((node) => {
    const old = before.get(node.id);
    const position =
      old && samePosition(old.position, node.position) ? old.position : node.position;
    if (
      old?.type === node.type &&
      old.parentId === node.parentId &&
      old.data === node.data &&
      position === old.position
    )
      return old;
    const next: CanvasNode & Partial<GeometryNode> = { ...node, position };
    delete next.width;
    delete next.height;
    return next;
  });
  const keptNodes =
    plain.length === doc.nodes.length && plain.every((node, i) => node === doc.nodes[i])
      ? doc.nodes
      : plain;
  const keptLinks =
    links.length === doc.links.length && links.every((link, i) => link === doc.links[i])
      ? doc.links
      : links;
  return {
    next:
      keptNodes === doc.nodes && keptLinks === doc.links
        ? doc
        : { ...doc, nodes: keptNodes, links: keptLinks },
    result,
  };
}

function moveUp(node: CanvasNode, parent: CanvasNode): CanvasNode {
  return withParent(
    {
      ...node,
      position: { x: node.position.x + parent.position.x, y: node.position.y + parent.position.y },
    },
    parent.parentId,
  );
}

function withParent<N extends CanvasNode>(node: N, parentId: string | undefined): N {
  const next = { ...node };
  if (parentId === undefined) delete next.parentId;
  else next.parentId = parentId;
  return next;
}

function indexById(nodes: readonly CanvasNode[]): Map<string, CanvasNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function parentOf(node: CanvasNode, byId: ReadonlyMap<string, CanvasNode>): CanvasNode | undefined {
  return node.parentId === undefined ? undefined : byId.get(node.parentId);
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

function near(a: Position, b: Position): boolean {
  return Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4;
}

function sameEnds(a: Ends, b: Ends): boolean {
  return a.source === b.source && a.target === b.target;
}
