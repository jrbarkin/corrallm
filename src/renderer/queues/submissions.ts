import type { Session } from '../../shared/model/session';
import type { CanvasNode } from '../../shared/model/canvas';
import { findItem } from '../../shared/model/queue';
import type { QueueMessage } from '../../shared/model/queue';

const projected = new WeakMap<
  CanvasNode,
  { submissions: Session['submissions']; node: CanvasNode }
>();

/**
 * Projects live manual submissions into the displayed queue. The saved workflow and runner
 * continue reading the original nodes: observing a prompt must never send it a second time.
 */
export function withSubmissions(
  nodes: readonly CanvasNode[],
  sessions: Readonly<Record<string, Session>>,
): CanvasNode[] {
  return nodes.map((node) => {
    const submissions = sessions[node.id]?.submissions;
    if (node.type !== 'agent' || !submissions?.length) return node;
    const kept = projected.get(node);
    if (kept?.submissions === submissions) return kept.node;
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
    const next: CanvasNode = {
      ...node,
      data: {
        ...node.data,
        queue: [
          ...(anchored.get(undefined) ?? []),
          ...queue.flatMap((item) => [item, ...(anchored.get(item.id) ?? [])]),
        ],
      },
    };
    projected.set(node, { submissions, node: next });
    return next;
  });
}
