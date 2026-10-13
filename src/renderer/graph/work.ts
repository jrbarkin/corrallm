import type { GraphNode } from './graph';
import { isApproval, isDelay, isIf, isRepeat, isWait } from './queue';
import type { QueueItem } from './queue';

/**
 * Work between two agents, as their queues make it: an edge from `from` to `to`, drawn (with an
 * arrowhead) whenever `from`'s queue aims a step or a message at `to`, or `to`'s queue waits for
 * `from` to finish.
 */
export interface WorkEdge {
  from: string;
  to: string;
  /** How many queued items make the edge. */
  count: number;
  /** Whether all of it is in if-thens, so it happens only if their conditions hold. */
  conditional: boolean;
}

/**
 * Whether `item`, in the queue of agent `owner`, is part of the work from `from` to `to`: in `from`'s
 * queue, a step or message aimed at `to` (or an if-then or a repeat holding one); in `to`'s queue, a
 * wait for `from` (or a repeat holding one).
 */
export function isWorkBetween(item: QueueItem, owner: string, from: string, to: string): boolean {
  if (isWait(item)) return owner === to && item.waitFor.some((target) => target.agent === from);
  // A delay or an OK holds the queue, and is no work.
  if (isDelay(item) || isApproval(item)) return false;
  if (isIf(item)) return item.then.some((step) => isWorkBetween(step, owner, from, to));
  if (isRepeat(item)) return item.repeat.some((inner) => isWorkBetween(inner, owner, from, to));
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
  const add = (from: string, to: string, conditional: boolean) => {
    if (from === to || !agents.has(from) || !agents.has(to)) return;
    const key = JSON.stringify([from, to]);
    const edge = edges.get(key);
    if (edge) {
      edge.count += 1;
      edge.conditional &&= conditional;
    } else {
      edges.set(key, { from, to, count: 1, conditional });
    }
  };
  for (const node of nodes) {
    // A wait is not conditional work: it is when the agent waiting goes on.
    const visit = (item: QueueItem, inIf: boolean) => {
      if (isWait(item)) {
        // Once per agent, whether the wait is for all of its work or for some of its steps.
        for (const agent of new Set(item.waitFor.map((target) => target.agent))) {
          add(agent, node.id, false);
        }
      } else if (isIf(item)) {
        for (const step of item.then) visit(step, true);
      } else if (isRepeat(item)) {
        // What a repeat holds happens, at least once.
        for (const inner of item.repeat) visit(inner, inIf);
      } else if (!isDelay(item) && !isApproval(item) && item.target !== undefined) {
        add(node.id, item.target, inIf);
      }
    };
    for (const item of node.data.queue ?? []) visit(item, false);
  }
  return [...edges.values()];
}
