import type { XYPosition } from '@xyflow/react';
import { autosize, size } from '../../shared/model/geometry';
import type { Graph, GraphNode } from './flow';
/**
 * Where a gesture put a node, in canvas coordinates (`at`), not its parent's: the commit that
 * lands the move refits its groups, moving the parent the position was relative to, and the
 * overlay is held until that commit's revision reaches the mirror, under it as well as before it.
 */
export type Overlay = Pick<GraphNode, 'dragging' | 'measured'> & { at: XYPosition };
export type Overlays = ReadonlyMap<string, Partial<Overlay>>;
const cache = new WeakMap<
  GraphNode,
  { overlay: Partial<Overlay>; origin: XYPosition | undefined; node: GraphNode }
>();
/** A gesture's transient view, held through its op's mirror acknowledgement. */
export function projectOverlay(graph: Graph, overlays: Overlays): Graph {
  // Parents come before their children: each node is placed in its parent as projected.
  const absolute = new Map<string, XYPosition>();
  const nodes = graph.nodes.map((node) => {
    const parent = node.parentId === undefined ? undefined : absolute.get(node.parentId);
    const shown = overlaid(node, overlays.get(node.id), parent);
    absolute.set(node.id, {
      x: (parent?.x ?? 0) + shown.position.x,
      y: (parent?.y ?? 0) + shown.position.y,
    });
    return shown;
  });
  if (![...overlays.values()].some((overlay) => overlay.at !== undefined))
    return { ...graph, nodes };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pinned = new Set<string>();
  for (const node of nodes)
    if (node.dragging)
      for (let id = node.parentId; id !== undefined; id = byId.get(id)?.parentId) pinned.add(id);
  return {
    ...graph,
    nodes: autosize<GraphNode>(nodes, {
      pinned,
      sizing: {
        size,
        // React Flow's next measurement must agree with a resized container immediately.
        resize: (node, dimensions) => ({ ...node, ...dimensions, measured: dimensions }),
      },
    }),
  };
}

function overlaid(
  node: GraphNode,
  overlay: Partial<Overlay> | undefined,
  origin: XYPosition | undefined,
): GraphNode {
  if (!overlay) return node;
  const kept = cache.get(node);
  if (kept?.overlay === overlay && kept.origin?.x === origin?.x && kept.origin?.y === origin?.y)
    return kept.node;
  const { at, ...rest } = overlay;
  const next = {
    ...node,
    ...rest,
    ...(at === undefined
      ? {}
      : { position: { x: at.x - (origin?.x ?? 0), y: at.y - (origin?.y ?? 0) } }),
  };
  cache.set(node, { overlay, origin, node: next });
  return next;
}
