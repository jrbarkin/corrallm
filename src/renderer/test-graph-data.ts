import type { CanvasId } from '../shared/canvas';
import type { CanvasDocument, CanvasNode } from '../shared/model/canvas';
import { autosize } from '../shared/model/geometry';
import type { Graph, GraphNode } from './graph/flow';
export const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };
/** Old view-shaped fixtures, converted only in tests; production reads the row mirror. */
export function graphOf(doc: CanvasDocument): Graph {
  return {
    arrange: doc.arrange,
    nodes: autosize(doc.nodes.map((node): GraphNode => ({ ...node }))),
    edges: doc.links.map((link) => ({
      id: `${link.source}->${link.target}`,
      source: link.source,
      target: link.target,
      ...(link.dots ? { sourceHandle: link.dots[0], targetHandle: link.dots[1] } : {}),
    })),
  };
}
export function canvasNodes(nodes: readonly GraphNode[]): CanvasNode[] {
  return nodes.map(({ id, type, position, parentId, data }) => ({
    id,
    type,
    position,
    ...(parentId === undefined ? {} : { parentId }),
    data,
  }));
}
export function documentOf(graph: Graph, id: CanvasId): CanvasDocument {
  return {
    id,
    arrange: graph.arrange ?? false,
    nodes: canvasNodes(graph.nodes),
    links: graph.edges.map(({ source, target, sourceHandle, targetHandle }) => ({
      source,
      target,
      ...(sourceHandle && targetHandle
        ? { dots: [sourceHandle, targetHandle] as [string, string] }
        : {}),
    })),
  };
}
