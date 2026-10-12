import type { GraphNode } from '../graph/graph';
import { isWait } from '../graph/queue';

/**
 * One end of a link: in a column (a queue, by the id its element has as `data-column`), an item
 * (`data-item`), or (null) the end of the queue (`data-end`), or (undefined) the column's edge,
 * level with the other end.
 */
export interface LinkEnd {
  column: string;
  item: string | null | undefined;
}

/** A line between queues: a wait, from what it waits for; or work one agent hands another. */
export interface QueueLink {
  key: string;
  from: LinkEnd;
  to: LinkEnd;
  kind?: 'wait' | 'handoff';
}

/**
 * What links two queues shown side by side, the open agent's (`own`) and another's (`peer`):
 * every wait in either for the other agent, from what it waits for (one of its items, or the end of
 * its queue for all of its work) to the wait.
 */
export function queueLinks(own: GraphNode, peer: GraphNode): QueueLink[] {
  const waits = (waiting: GraphNode, column: 'own' | 'peer', other: GraphNode) =>
    (waiting.data.queue ?? []).flatMap((item) =>
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
