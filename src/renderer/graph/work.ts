import type { GraphNode } from './graph';
import { isIf, isMessage } from './queue';
import type { QueueItem } from './queue';

/**
 * Work between two agents, as their queues make it: an edge from `from` to `to`, drawn (with an
 * arrowhead) whenever `from`'s queue aims a step at `to`, or `to`'s queue waits for `from`.
 */
export interface WorkEdge {
  from: string;
  to: string;
  /** How many queued items make the edge. */
  count: number;
}

/**
 * Whether `item`, in the queue of agent `owner`, is part of the work from `from` to `to`: in `from`'s
 * queue, a step aimed at `to` (or an if-then holding one); in `to`'s queue, an if-then that waits
 * for `from` to finish.
 */
export function isWorkBetween(item: QueueItem, owner: string, from: string, to: string): boolean {
  if (isMessage(item)) return false;
  if (isIf(item)) {
    const waits = owner === to && item.if.kind === 'nodeDone' && item.if.node === from;
    return waits || item.then.some((step) => isWorkBetween(step, owner, from, to));
  }
  return owner === from && item.target === to;
}

/**
 * The work edges the agents' queues make, one for each direction between two agents that has any,
 * in the order the queues first mention them. Steps aimed at the queue's own agent, or at an agent
 * that no longer exists, make none.
 */
export function workEdges(nodes: readonly GraphNode[]): WorkEdge[] {
  const agents = new Set(nodes.filter((n) => n.type === 'agent').map((n) => n.id));
  const edges = new Map<string, WorkEdge>();
  const add = (from: string, to: string) => {
    if (from === to || !agents.has(from) || !agents.has(to)) return;
    const key = JSON.stringify([from, to]);
    const edge = edges.get(key);
    if (edge) edge.count += 1;
    else edges.set(key, { from, to, count: 1 });
  };
  for (const node of nodes) {
    const visit = (item: QueueItem) => {
      if (isMessage(item)) return;
      if (isIf(item)) {
        if (item.if.kind === 'nodeDone') add(item.if.node, node.id);
        item.then.forEach(visit);
      } else if (item.target !== undefined) {
        add(node.id, item.target);
      }
    };
    node.data.queue?.forEach(visit);
  }
  return [...edges.values()];
}
