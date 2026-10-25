import type { CanvasId } from '../../shared/canvas';
import type { RuntimeTopicStates } from '../../shared/api/topics';
import type { CanvasNode } from '../../shared/model/canvas';
import type { QueueItem, QueueMessage, SubmittedMessage } from '../../shared/model/queue';
import type { MessageView } from '../../shared/model/views';
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
      return {
        id: message.id,
        message: text,
        submission: submissionOf(message, Object.values(messages.items)),
      } satisfies QueueMessage;
    });
    const projected = { ...node, data: { ...node.data, queue } };
    cached.set(node, { messages, node: projected });
    return projected;
  });
}

/** Legacy queue widgets consume read-only message records, not an executable second queue. */
export function submissionOf(message: MessageView, all: readonly MessageView[]): SubmittedMessage {
  const text = message.display?.text ?? message.body;
  const response = all.find((one) => one.replyTo === message.id && one.kind === 'text');
  const turn = message.turn ?? response?.turn;
  const status =
    message.state === 'pending'
      ? 'queued'
      : message.state === 'delivered' || message.state === 'delivering'
        ? 'running'
        : message.state === 'withdrawn' || turn?.status === 'cancelled'
          ? 'cancelled'
          : turn?.status === 'failed' || message.state === 'unresolved'
            ? 'failed'
            : 'completed';
  const reply = response?.body;
  return {
    id: message.id,
    text,
    status,
    ...(reply === undefined ? {} : { reply }),
    ...(turn ? { result: turn } : {}),
    ...(message.state === 'unresolved' ? { unresolved: true } : {}),
    ...(message.display?.after ? { after: message.display.after } : {}),
    ...(message.display?.task ? { task: { ...message.display.task } } : {}),
  };
}
