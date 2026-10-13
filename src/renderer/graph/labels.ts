import { threadTitle } from '../agent/session';
import type { GraphNode } from './graph';
import { CONDITIONS, isIf, isMessage, isWait } from './queue';
import type { Condition, QueueItem, WaitTarget } from './queue';

/** How a condition reads after "If". */
export const ifText = (condition: Condition): string =>
  condition.kind === 'outputContains'
    ? `the output contains "${condition.text}"`
    : condition.kind === 'freeText'
      ? condition.text
      : (CONDITIONS.find((c) => c.kind === condition.kind)?.label ?? '');

/** How a queue item reads when another agent waits for it. */
export const itemLabel = (item: QueueItem): string =>
  isWait(item)
    ? 'its wait'
    : isIf(item)
      ? `If ${ifText(item.if)}`
      : isMessage(item)
        ? item.message.trim() === ''
          ? 'an empty message'
          : `“${threadTitle(item.message, 24)}”`
        : item.action;

/** An agent's name: its label, "Unnamed agent" without one, or "Deleted agent" once it is gone. */
export function agentName(nodes: readonly GraphNode[], id: string): string {
  const node = nodes.find((n) => n.id === id);
  return node ? node.data.label || 'Unnamed agent' : 'Deleted agent';
}

/** What a wait waits for, in words: an agent (all of its work), or one of its items. */
export function waitTargetLabel(nodes: readonly GraphNode[], { agent, item }: WaitTarget): string {
  if (item === undefined) return agentName(nodes, agent);
  const found = nodes.find((n) => n.id === agent)?.data.queue?.find((q) => q.id === item);
  return `${agentName(nodes, agent)}: ${found ? itemLabel(found) : 'a removed step'}`;
}

/** "a", "a and b", "a, b and c". */
export function andList(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${String(names.at(-1))}`;
}

/** How an item reads in full, as All queues names it: what it does, and to which agent. */
export function taskLabel(nodes: readonly GraphNode[], item: QueueItem): string {
  if (isWait(item))
    return `Wait for ${andList(item.waitFor.map((target) => waitTargetLabel(nodes, target)))}`;
  if (isIf(item)) return `If ${ifText(item.if)}`;
  const what = isMessage(item)
    ? `Message ${item.message.trim() === '' ? '(empty)' : `“${threadTitle(item.message, 32)}”`}`
    : item.action;
  return item.target === undefined ? what : `${what} → ${agentName(nodes, item.target)}`;
}
