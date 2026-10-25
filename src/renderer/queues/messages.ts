import type { CanvasId } from '../../shared/canvas';
import type { RuntimeTopicStates } from '../../shared/api/topics';
import type { CanvasNode } from '../../shared/model/canvas';
import type { QueueItem, QueueMessage } from '../../shared/model/queue';
import { queueRows } from '../../shared/model/views';

type Messages = RuntimeTopicStates[`messages:${CanvasId}`];
const cached = new WeakMap<CanvasNode, { messages: Messages; node: CanvasNode }>();
/** The existing queue widgets' display adapter over AuthoredRow | MessageRow. Never an edit. */
export function messageQueues(
  nodes: readonly CanvasNode[],
  messages: Messages | undefined,
): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type !== 'agent' || !messages) return node;
    const kept = cached.get(node);
    if (kept?.messages === messages) return kept.node;
    const incoming = messages.order.flatMap((id) => {
      const message = messages.items[id];
      return message?.to === `agent:${node.id}` &&
        message.kind === 'text' &&
        message.origin !== 'run'
        ? [message]
        : [];
    });
    if (!incoming.length) return node;
    const queue = queueRows(node.data.queue ?? [], incoming).map((row): QueueItem => {
      if (row.kind === 'authored') {
        const item = (node.data.queue ?? []).find((item) => item.id === row.item.id);
        if (!item) throw new Error('Missing authored row');
        return item;
      }
      const message = row.message;
      const text = message.display?.text ?? message.body;
      const status =
        message.state === 'pending'
          ? 'queued'
          : message.state === 'delivered' || message.state === 'delivering'
            ? 'running'
            : message.state === 'withdrawn' || message.turn?.status === 'cancelled'
              ? 'cancelled'
              : message.turn?.status === 'failed' || message.state === 'unresolved'
                ? 'failed'
                : 'completed';
      return {
        id: message.id,
        message: text,
        submission: {
          id: message.id,
          text,
          status,
          ...(message.turn === undefined ? {} : { result: message.turn }),
          ...(message.state === 'unresolved' ? { unresolved: true } : {}),
          ...(message.display?.after === undefined ? {} : { after: message.display.after }),
        },
      } satisfies QueueMessage;
    });
    const projected = { ...node, data: { ...node.data, queue } };
    cached.set(node, { messages, node: projected });
    return projected;
  });
}
