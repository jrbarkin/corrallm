import type { CanvasNode } from '../../shared/model/canvas';
import type { Graph } from './flow';

export interface Selection {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}
export const EMPTY_SELECTION: Selection = { nodes: new Set(), edges: new Set() };
export function selectOnly(current: Selection, id: string): Selection {
  return current.nodes.size === 1 && current.nodes.has(id) && current.edges.size === 0
    ? current
    : { nodes: new Set([id]), edges: new Set() };
}
const selected = new WeakMap<object, object>();
function select<T extends object>(value: T): T {
  let copy = selected.get(value);
  if (!copy) {
    copy = { ...value, selected: true };
    selected.set(value, copy);
  }
  return copy as T;
}
export function projectSelection(graph: Graph, selection: Selection): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (selection.nodes.has(n.id) ? select(n) : n)),
    edges: graph.edges.map((e) => (selection.edges.has(e.id) ? select(e) : e)),
  };
}

/** What remains selected when a group is released: its immediate children, or the moved node. */
export function released(nodes: readonly CanvasNode[], ids: readonly string[]): Selection {
  const selected = ids.flatMap((id) => {
    const children = nodes.filter((node) => node.parentId === id);
    return children.length
      ? children.map((node) => node.id)
      : nodes.some((node) => node.id === id && node.type === 'frame')
        ? []
        : [id];
  });
  return { nodes: new Set(selected), edges: new Set() };
}
