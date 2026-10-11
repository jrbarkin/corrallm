import { Graph as Layered, layout } from '@dagrejs/dagre';
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre';
import type { Edge } from '@xyflow/react';

import { autosize, PADDING, size, topInset } from './graph';
import type { Graph, GraphNode } from './graph';

/** Space between neighbouring nodes in a row, and between rows. */
const NODE_GAP = 40;
const RANK_GAP = 60;

/**
 * Lays the graph out top to bottom along its edges (dagre's layered layout): each group's nodes
 * inside it, innermost groups first, then every group among its siblings. An edge into or out of a
 * group counts, at each level, as an edge of whatever there holds its end. The graph stays where it
 * was, and an arranged graph is returned as it is.
 */
export function arrange(graph: Graph): Graph {
  const parentIds = new Set(graph.nodes.flatMap((n) => n.parentId ?? []));
  // Children come after their parents, so going backwards reaches inner groups first.
  const groups = graph.nodes.filter((n) => parentIds.has(n.id)).reverse();
  let nodes = graph.nodes;
  for (const group of groups) nodes = autosize(placeChildren(nodes, graph.edges, group));
  nodes = placeChildren(nodes, graph.edges, undefined);
  return nodes.every((n, i) => n === graph.nodes[i]) ? graph : { ...graph, nodes };
}

/** Lays out the nodes directly inside `group` (or at the top level). */
function placeChildren(
  nodes: GraphNode[],
  edges: readonly Edge[],
  group: GraphNode | undefined,
): GraphNode[] {
  const children = nodes.filter((n) => n.parentId === group?.id);
  if (children.length === 0) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIds = new Set(children.map((n) => n.id));
  /** The node at this level that is, or holds, node `id`. */
  const holder = (id: string): string | undefined => {
    for (let n = byId.get(id); n; n = n.parentId === undefined ? undefined : byId.get(n.parentId)) {
      if (childIds.has(n.id)) return n.id;
    }
    return undefined;
  };

  const layered = new Layered<GraphLabel, NodeLabel, EdgeLabel>();
  layered.setGraph({ rankdir: 'TB', nodesep: NODE_GAP, ranksep: RANK_GAP });
  layered.setDefaultEdgeLabel(() => ({}));
  for (const child of children) layered.setNode(child.id, { ...size(child) });
  for (const edge of edges) {
    const from = holder(edge.source);
    const to = holder(edge.target);
    if (from !== undefined && to !== undefined && from !== to) layered.setEdge(from, to);
  }
  layout(layered);

  const topLeft = new Map(
    children.map((child) => {
      const { x = 0, y = 0 } = layered.node(child.id);
      const { width, height } = size(child);
      return [child.id, { x: x - width / 2, y: y - height / 2 }];
    }),
  );
  const placed = [...topLeft.values()];
  const shift = {
    x: Math.min(...placed.map((p) => p.x)),
    y: Math.min(...placed.map((p) => p.y)),
  };
  // Inside a group, start at its padding (so autosize leaves it in place); at the top level, keep
  // the graph's top-left corner where it was.
  const origin = group
    ? { x: PADDING, y: topInset(group.type) }
    : {
        x: Math.min(...children.map((n) => n.position.x)),
        y: Math.min(...children.map((n) => n.position.y)),
      };
  return nodes.map((n) => {
    const p = topLeft.get(n.id);
    if (!p) return n;
    const position = {
      x: Math.round(p.x - shift.x + origin.x),
      y: Math.round(p.y - shift.y + origin.y),
    };
    return position.x === n.position.x && position.y === n.position.y ? n : { ...n, position };
  });
}
