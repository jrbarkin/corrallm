import type { CanvasNode, NodeLike, Position } from './canvas';

/*
 * How big a canvas's boxes are: an agent's card, and the groups that fit what they hold. The views
 * draw them so (src/renderer/graph/GraphEditor.css), and a canvas's file names a group's colour
 * by its index among GROUP_COLORS.
 */

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

/** A model node with its computed box; sizes are derived, never saved in the canvas. */
export interface GeometryNode extends NodeLike {
  position: Position;
  width?: number;
  height?: number;
  data: NodeLike['data'] & { color?: number };
}

export interface Size {
  width: number;
  height: number;
}

/** A view may supply its own box reader and writer; the model uses CARD_SIZE and plain sizes. */
export interface Sizing<N extends GeometryNode> {
  size(node: N): Size;
  resize(node: N, dimensions: Size): N;
}

/**
 * The colour each node shows: a group its own, any other node that of the innermost group it is in.
 * Nodes outside any group have none.
 */
export function groupColors(nodes: readonly GeometryNode[]): Map<string, number> {
  const byId = indexById(nodes);
  const parentIds = new Set(nodes.map((n) => n.parentId));
  const colors = new Map<string, number>();
  for (const node of nodes) {
    for (let n: GeometryNode | undefined = node; n; n = parentOf(n, byId)) {
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
export function nextGroupColor(nodes: readonly GeometryNode[]): number {
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

/** Position in canvas coordinates: the sum of the positions up the parent chain. */
export function absolutePosition(
  node: GeometryNode,
  byId: ReadonlyMap<string, GeometryNode>,
): Position {
  let { x, y } = node.position;
  for (let p = parentOf(node, byId); p; p = parentOf(p, byId)) {
    x += p.position.x;
    y += p.position.y;
  }
  return { x, y };
}

/**
 * The innermost container (frame, or item with children) whose box contains `point` (canvas
 * coordinates). Among overlapping containers at the same depth the later one, drawn on top, wins.
 */
export function containerAt<N extends GeometryNode>(
  nodes: readonly N[],
  point: Position,
  readSize: (node: N) => Size = size,
): N | undefined {
  const byId = indexById(nodes);
  const parentIds = new Set(nodes.map((n) => n.parentId));
  let best: { node: N; depth: number } | undefined;
  for (const node of nodes) {
    if (node.type !== 'frame' && !parentIds.has(node.id)) continue;
    const { x, y } = absolutePosition(node, byId);
    const { width, height } = readSize(node);
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
 * nodes keep their identity. `pinned` containers keep their top-left corners while their right
 * and bottom edges follow their children; the caller releases them when it may fit all edges.
 */
export function autosize<N extends GeometryNode>(
  nodes: N[],
  {
    pinned = new Set<string>(),
    sizing = { size, resize: resized },
  }: {
    pinned?: ReadonlySet<string>;
    sizing?: Sizing<N>;
  } = {},
): N[] {
  const childIndices = new Map<string, number[]>();
  for (const [i, node] of nodes.entries()) {
    if (node.parentId === undefined) continue;
    const indices = childIndices.get(node.parentId);
    if (indices) indices.push(i);
    else childIndices.set(node.parentId, [i]);
  }
  let result = nodes;
  const set = (i: number, node: N) => {
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
      const fitted = childless(node, sizing);
      if (fitted !== node) set(i, fitted);
      continue;
    }
    const children = indices.map((j) => result[j]).filter((n) => n !== undefined);
    const { x1, y1, x2, y2 } = bounds(children, (child) => sizing.size(child));
    const top = topInset(node.type);
    const dx = pinned.has(node.id) ? 0 : x1 - PADDING;
    const dy = pinned.has(node.id) ? 0 : y1 - top;
    const fit = { width: x2 - dx + PADDING, height: y2 - dy + PADDING };
    if (dx === 0 && dy === 0 && hasSize(node, fit, sizing)) continue;
    const position = { x: node.position.x + dx, y: node.position.y + dy };
    set(i, sizing.resize({ ...node, position }, fit));
    if (dx === 0 && dy === 0) continue;
    for (const j of indices) {
      const child = result[j];
      if (child)
        set(j, { ...child, position: { x: child.position.x - dx, y: child.position.y - dy } });
    }
  }
  return result;
}

/** A node's computed box, or the fixed card size before a container is fitted. */
export function size(node: GeometryNode): Size {
  return {
    width: node.width ?? CARD_SIZE.width,
    height: node.height ?? CARD_SIZE.height,
  };
}

/**
 * How far below a container's top its children start: past the header zone at the top of its box
 * (a frame's label bar), plus PADDING. A parent node's box starts half a card lower, because its
 * card straddles the box's top border; so a frame that gets a parent keeps its border in place.
 */
export function topInset(kind: CanvasNode['type'] | undefined): number {
  return (kind === 'frame' ? 0 : CARD_SIZE.height / 2) + HEADER + PADDING;
}

/** A node without children: frames shrink to EMPTY_FRAME, items lose their container size. */
function childless<N extends GeometryNode>(node: N, sizing: Sizing<N>): N {
  if (node.type === 'frame')
    return hasSize(node, EMPTY_FRAME, sizing) ? node : sizing.resize(node, EMPTY_FRAME);
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

function hasSize<N extends GeometryNode>(
  node: N,
  { width, height }: Size,
  sizing: Sizing<N>,
): boolean {
  const current = sizing.size(node);
  return (
    node.width === width &&
    node.height === height &&
    current.width === width &&
    current.height === height
  );
}

/** Sets the computed box, without changing the node's data. */
function resized<T extends GeometryNode>(node: T, { width, height }: Size): T {
  return { ...node, width, height };
}

/** The box around `nodes` (non-empty), in their parent's coordinates. */
export function bounds<N extends GeometryNode>(
  nodes: readonly N[],
  readSize: (node: N) => Size = size,
): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  return {
    x1: Math.min(...nodes.map((n) => n.position.x)),
    y1: Math.min(...nodes.map((n) => n.position.y)),
    x2: Math.max(...nodes.map((n) => n.position.x + readSize(n).width)),
    y2: Math.max(...nodes.map((n) => n.position.y + readSize(n).height)),
  };
}

function indexById<N extends NodeLike>(nodes: readonly N[]): Map<string, N> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function parentOf<N extends NodeLike>(node: N, byId: ReadonlyMap<string, N>): N | undefined {
  return node.parentId === undefined ? undefined : byId.get(node.parentId);
}
