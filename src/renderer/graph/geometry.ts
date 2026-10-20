import {
  autosize as fitNodes,
  bounds as nodeBounds,
  containerAt as containingNode,
  size as nodeSize,
} from '../../shared/model/geometry';
import type { Size, Sizing } from '../../shared/model/geometry';
import type { Position } from '../../shared/model/canvas';
import type { GraphNode } from './graph';

/** The view's dimensions, falling back to the model's fixed card size before it is drawn. */
export function size(node: GraphNode): Size {
  const fallback = nodeSize(node);
  return {
    width: node.measured?.width ?? fallback.width,
    height: node.measured?.height ?? fallback.height,
  };
}

const sizing: Sizing<GraphNode> = {
  size,
  // React Flow can show a resized group at once, before its next measurement.
  resize: (node, dimensions) => ({ ...node, ...dimensions, measured: dimensions }),
};

/** Pins ancestors during a drag, when moving them would swallow React Flow's next drag move. */
export function autosize(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pinned = new Set<string>();
  for (const node of nodes) {
    if (!node.dragging) continue;
    for (let id = node.parentId; id !== undefined; id = byId.get(id)?.parentId) pinned.add(id);
  }
  return fitNodes(nodes, { pinned, sizing });
}

export function bounds(nodes: readonly GraphNode[]): ReturnType<typeof nodeBounds> {
  return nodeBounds(nodes, size);
}

export function containerAt(nodes: readonly GraphNode[], point: Position): GraphNode | undefined {
  return containingNode(nodes, point, size);
}
