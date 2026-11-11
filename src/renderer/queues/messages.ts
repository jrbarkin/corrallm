import type { CanvasId } from '../../shared/canvas';
import type { RuntimeTopicStates } from '../../shared/api/topics';
import type { CanvasNode } from '../../shared/model/canvas';
import { isQueueHandoff } from '../../shared/model/messages';
import type { QueueItem, QueueMessage, SubmittedMessage } from '../../shared/model/queue';
import { topLevelOf } from '../../shared/model/queue';
import type { MessageView } from '../../shared/model/views';
import { isQueueRowMessage, queueRows } from '../../shared/model/views';

type Messages = RuntimeTopicStates[`messages:${CanvasId}`];
/** The part of the run a hand-off's place reads: which task each agent is on. */
interface Position {
  readonly agents: Readonly<Record<string, { readonly current?: string | undefined }>>;
}
interface Incoming {
  message: MessageView;
  response: MessageView | undefined;
}

/** Immutable topic snapshots share one mailbox index across every queue and run update. */
const indexes = new WeakMap<Messages, ReadonlyMap<string, readonly Incoming[]>>();
const EMPTY: readonly Incoming[] = [];
function indexOf(messages: Messages): ReadonlyMap<string, readonly Incoming[]> {
  const kept = indexes.get(messages);
  if (kept) return kept;
  const responses = new Map<string, MessageView>();
  for (const message of Object.values(messages.items)) {
    const replyTo = message.replyTo;
    if (message.kind === 'text' && replyTo !== undefined && !responses.has(replyTo))
      responses.set(replyTo, message);
  }
  const incoming = new Map<string, Incoming[]>();
  for (const id of messages.order) {
    const message = messages.items[id];
    if (
      !message ||
      !isQueueRowMessage(message) ||
      (isQueueHandoff(message) && (!open(message) || message.task === undefined))
    )
      continue;
    const to = message.to;
    let line = incoming.get(to);
    if (!line) incoming.set(to, (line = []));
    line.push({ message, response: responses.get(message.id) });
  }
  indexes.set(messages, incoming);
  return incoming;
}

function sameLine(a: readonly Incoming[], b: readonly Incoming[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((row, i) => {
        const other = b[i];
        return row.message === other?.message && row.response === other.response;
      }))
  );
}

const cached = new WeakMap<
  CanvasNode,
  {
    incoming: readonly Incoming[];
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
  if (!messages) return [...nodes];
  const indexed = indexOf(messages);
  const names = new Map(nodes.map((node) => [node.id, node.data.label || 'Unnamed agent']));
  const nameOf = (id: string) => names.get(id) ?? 'Deleted agent';
  return nodes.map((node) => {
    if (node.type !== 'agent') return node;
    const line = indexed.get(`agent:${node.id}`) ?? EMPTY;
    if (line.length === 0) return node;
    const submissions = observed?.agent === node.id ? observed.submissions : undefined;
    const current = run?.agents[node.id]?.current;
    const kept = cached.get(node);
    if (
      kept !== undefined &&
      sameLine(kept.incoming, line) &&
      kept.observed === submissions &&
      kept.current === current &&
      [...kept.senders].every(([id, name]) => nameOf(id) === name)
    )
      return kept.node;
    const senders = new Map<string, string>();
    const place = placeOf(node, current);
    const incoming = line.map(({ message }) => {
      if (!isQueueHandoff(message) || message.task === undefined) return message;
      senders.set(message.task.agent, nameOf(message.task.agent));
      const display = { ...message.display, ...(place === undefined ? {} : { after: place }) };
      return { ...message, display };
    });
    const responses = new Map(line.map(({ message, response }) => [message.id, response]));
    const authored = new Map((node.data.queue ?? []).map((item) => [item.id, item]));
    const observedById = new Map(submissions?.map((submission) => [submission.id, submission]));
    const queue = queueRows(node.data.queue ?? [], incoming).map((row): QueueItem => {
      if (row.kind === 'authored') {
        const item = authored.get(row.item.id);
        if (!item) throw new Error('Missing authored row');
        return item;
      }
      const message = row.message;
      const text = message.display?.text ?? message.body;
      const submission =
        observedById.get(message.id) ?? submissionFrom(message, responses.get(message.id));
      return {
        id: message.id,
        message: text,
        submission:
          isQueueHandoff(message) && message.task !== undefined
            ? {
                ...submission,
                handoff: { from: nameOf(message.task.agent), item: message.task.item },
              }
            : submission,
      } satisfies QueueMessage;
    });
    const projected = { ...node, data: { ...node.data, queue } };
    cached.set(node, {
      incoming: line,
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
  return submissionFrom(
    message,
    all.find((one) => one.replyTo === message.id && one.kind === 'text'),
  );
}

function submissionFrom(message: MessageView, response: MessageView | undefined): SubmittedMessage {
  const text = message.display?.text ?? message.body;
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
