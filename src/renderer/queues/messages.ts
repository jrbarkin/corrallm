import type { CanvasId } from '../../shared/canvas';
import type { RuntimeTopicStates } from '../../shared/api/topics';
import type { CanvasNode } from '../../shared/model/canvas';
import { isQueueHandoff } from '../../shared/model/messages';
import type { QueueItem, QueueMessage, SubmittedMessage } from '../../shared/model/queue';
import { topLevelOf } from '../../shared/model/queue';
import { agentName } from '../../shared/model/queries';
import type { MessageView } from '../../shared/model/views';
import { isQueueRowMessage, queueRows } from '../../shared/model/views';

type Messages = RuntimeTopicStates[`messages:${CanvasId}`];
/** The part of the run a hand-off's place reads: which task each agent is on. */
interface Position {
  readonly agents: Readonly<Record<string, { readonly current?: string | undefined }>>;
}
const cached = new WeakMap<
  CanvasNode,
  {
    messages: Messages;
    node: CanvasNode;
    observed?: readonly SubmittedMessage[];
    /** The task the agent was on, and its hand-offs' senders' names, as the rows were drawn. */
    current: string | undefined;
    senders: ReadonlyMap<string, string>;
  }
>();

/**
 * Where a hand-off for `node` sits among its queue (B19 X2): after the item at the top of the queue
 * that the agent is on now (a step of an if-then or a repeat being on its if-then or repeat), else
 * at the end. The core's `current` is the only place read: a hand-off's own `display` is none.
 */
function placeOf(node: CanvasNode, current: string | undefined): string | undefined {
  if (node.type !== 'agent') return undefined;
  const queue = node.data.queue ?? [];
  return topLevelOf(queue, current) ?? queue.at(-1)?.id;
}

/** Whether a queue hand-off is still the recipient's to see: not one its turn has ended. */
function open(message: MessageView): boolean {
  return message.state !== 'replied' && message.state !== 'answered' && message.state !== 'expired';
}

/**
 * The existing queue widgets' display adapter over AuthoredRow | MessageRow. Never an edit, and
 * never the runner's input: a row it adds carries a `submission` (a record, which no save, wait
 * target or reorder reads), a hand-off's with its sender and the item it carries.
 */
export function messageQueues(
  nodes: readonly CanvasNode[],
  messages: Messages | undefined,
  observed?: { agent: string; submissions: readonly SubmittedMessage[] },
  run?: Position,
): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type !== 'agent' || !messages) return node;
    const submissions = observed?.agent === node.id ? observed.submissions : undefined;
    const current = run?.agents[node.id]?.current;
    const kept = cached.get(node);
    if (
      kept?.messages === messages &&
      kept.observed === submissions &&
      kept.current === current &&
      [...kept.senders].every(([id, name]) => agentName(nodes, id) === name)
    )
      return kept.node;
    const senders = new Map<string, string>();
    const place = placeOf(node, current);
    const incoming = messages.order.flatMap((id) => {
      const message = messages.items[id];
      if (message?.to !== `agent:${node.id}` || !isQueueRowMessage(message)) return [];
      if (!isQueueHandoff(message)) return [message];
      if (!open(message) || message.task === undefined) return [];
      senders.set(message.task.agent, agentName(nodes, message.task.agent));
      const display = { ...message.display, ...(place === undefined ? {} : { after: place }) };
      return [{ ...message, display }];
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
      const submission =
        submissions?.find(({ id }) => id === message.id) ??
        submissionOf(message, Object.values(messages.items));
      return {
        id: message.id,
        message: text,
        submission:
          isQueueHandoff(message) && message.task !== undefined
            ? {
                ...submission,
                handoff: { from: agentName(nodes, message.task.agent), item: message.task.item },
              }
            : submission,
      } satisfies QueueMessage;
    });
    const projected = { ...node, data: { ...node.data, queue } };
    cached.set(node, {
      messages,
      node: projected,
      current,
      senders,
      ...(submissions === undefined ? {} : { observed: submissions }),
    });
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
