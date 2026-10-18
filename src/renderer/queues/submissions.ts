import type { Session } from '../agent/session';
import type { GraphNode } from '../graph/graph';
import { findItem } from '../../shared/model/queue';
import type { QueueMessage } from '../../shared/model/queue';

/**
 * Projects live manual submissions into the displayed queue. The saved workflow and runner
 * continue reading the original nodes: observing a prompt must never send it a second time.
 */
export function withSubmissions(
  nodes: readonly GraphNode[],
  sessions: Readonly<Record<string, Session>>,
): GraphNode[] {
  return nodes.map((node) => {
    const submissions = sessions[node.id]?.submissions;
    if (node.type !== 'agent' || !submissions?.length) return node;
    const queue = node.data.queue ?? [];
    const anchored = new Map<string | undefined, QueueMessage[]>();
    for (const submission of submissions) {
      const after = queue.find(
        (item) =>
          submission.after !== undefined && findItem([item], submission.after) !== undefined,
      )?.id;
      const rows = anchored.get(after) ?? [];
      rows.push({ id: submission.id, message: submission.text, submission });
      anchored.set(after, rows);
    }
    return {
      ...node,
      data: {
        ...node.data,
        queue: [
          ...(anchored.get(undefined) ?? []),
          ...queue.flatMap((item) => [item, ...(anchored.get(item.id) ?? [])]),
        ],
      },
    };
  });
}
