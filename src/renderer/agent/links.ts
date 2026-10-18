import type { GraphNode } from '../graph/graph';
import { isWait, withRepeated } from '../graph/queue';

/** One end of a link: an item in a column's queue, or (null) the end of that queue. */
export interface LinkEnd {
  column: 'own' | 'peer';
  item: string | null;
}

/** A wait in one queue, linked from what it waits for in the other. */
export interface QueueLink {
  key: string;
  from: LinkEnd;
  to: LinkEnd;
}

/**
 * What links two queues shown side by side, the open agent's (`own`) and another's (`peer`):
 * every wait in either for the other agent (in its queue, or in a repeat there), from what it waits
 * for (one of its items, at any depth, or the end of its queue for all of its work) to the wait.
 */
export function queueLinks(own: GraphNode, peer: GraphNode): QueueLink[] {
  const waits = (waiting: GraphNode, column: LinkEnd['column'], other: GraphNode) =>
    withRepeated(waiting.data.queue ?? []).flatMap((item) =>
      isWait(item)
        ? item.waitFor
            .filter((target) => target.agent === other.id)
            .map((target): QueueLink => ({
              key: `${item.id}>${target.item ?? 'end'}`,
              from: { column: column === 'own' ? 'peer' : 'own', item: target.item ?? null },
              to: { column, item: item.id },
            }))
        : [],
    );
  return [...waits(own, 'own', peer), ...waits(peer, 'peer', own)];
}
