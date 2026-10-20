import { autosize, size } from '../../shared/model/geometry';
import type { Graph, GraphNode } from './flow';
export type Overlay = Pick<GraphNode, 'position' | 'dragging' | 'measured'>;
export type Overlays = ReadonlyMap<string, Partial<Overlay>>;
const cache = new WeakMap<GraphNode, { overlay: Partial<Overlay>; node: GraphNode }>();
/** A gesture's transient view, held through its op's mirror acknowledgement. */
export function projectOverlay(graph: Graph, overlays: Overlays): Graph {
  const nodes = graph.nodes.map((node) => {
    const overlay = overlays.get(node.id);
    if (!overlay) return node;
    const kept = cache.get(node);
    if (kept?.overlay === overlay) return kept.node;
    const next = { ...node, ...overlay };
    cache.set(node, { overlay, node: next });
    return next;
  });
  if (![...overlays.values()].some((overlay) => overlay.position !== undefined))
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
