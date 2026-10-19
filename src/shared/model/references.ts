import type { NodeLike } from './canvas';
import { agentName } from './queries';
import {
  checkedBy,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isRepeatEnds,
  isWait,
} from './queue';
import type { QueueItem, QueueMessage, QueueStep, RepeatedItem } from './queue';
import { andList } from './words';

/**
 * Clears surviving queues before nodes are deleted, keeping the original nodes for the words that
 * name them. Deletion and reparenting belong to the caller. References to items removed by this
 * cleanup are cleared too; repeat bodies whose leader or checked task is gone run once.
 */
export function clearDeletedReferences<N extends NodeLike>(
  nodes: readonly N[],
  deleted: ReadonlySet<string>,
): { nodes: readonly N[]; cleared: string[] } {
  const cleared: string[] = [];
  if (deleted.size === 0) return { nodes, cleared };
  const removedItems = new Set<string>();
  const key = (agent: string, item: string) => JSON.stringify([agent, item]);
  const gone = (agent: string, item?: string) =>
    deleted.has(agent) || (item !== undefined && removedItems.has(key(agent, item)));
  const reference = (agent: string, item?: string) =>
    `${agentName(nodes, agent)}${item === undefined ? '' : `’s ${itemName(nodes, agent, item)}`}`;
  const own = (agent: string, item: QueueItem) => reference(agent, item.id);

  function removed(agent: string, item: QueueItem, contents = true): void {
    removedItems.add(key(agent, item.id));
    if (!contents) return;
    const inner = isIf(item) ? item.then : isRepeat(item) ? item.repeat : [];
    for (const child of inner) removed(agent, child);
  }

  function clearLeaf(
    item: QueueStep | QueueMessage,
    agent: string,
  ): QueueStep | QueueMessage | undefined;
  function clearLeaf(item: RepeatedItem, agent: string): RepeatedItem | undefined;
  function clearLeaf(item: RepeatedItem, agent: string): RepeatedItem | undefined {
    if (isDelay(item)) return item;
    if (isWait(item)) {
      const lost = item.waitFor.filter((target) => gone(target.agent, target.item));
      if (lost.length === 0) return item;
      const waitFor = item.waitFor.filter((target) => !gone(target.agent, target.item));
      const targets = andList(lost.map((target) => reference(target.agent, target.item)));
      cleared.push(
        waitFor.length
          ? `${own(agent, item)} no longer waits for ${targets}.`
          : `${own(agent, item)} for ${targets} was removed.`,
      );
      if (waitFor.length) return { ...item, waitFor };
      removed(agent, item);
      return undefined;
    }
    if (isMessage(item)) {
      if (!item.submission && item.target !== undefined && deleted.has(item.target)) {
        cleared.push(`${own(agent, item)} to ${agentName(nodes, item.target)} was removed.`);
        removed(agent, item);
        return undefined;
      }
      let submission = item.submission;
      if (submission?.task && gone(submission.task.agent, submission.task.item)) {
        cleared.push(
          `${own(agent, item)} is no longer associated with ${reference(submission.task.agent, submission.task.item)}.`,
        );
        submission = { ...submission };
        delete submission.task;
      }
      if (submission?.after !== undefined && gone(agent, submission.after)) {
        cleared.push(
          `${own(agent, item)} no longer follows ${reference(agent, submission.after)}.`,
        );
        submission = { ...submission };
        delete submission.after;
      }
      const next = submission && submission !== item.submission ? { ...item, submission } : item;
      if (next.target === undefined || !deleted.has(next.target)) return next;
      const untargeted = { ...next };
      delete untargeted.target;
      cleared.push(`${own(agent, item)} no longer targets ${agentName(nodes, next.target)}.`);
      return untargeted;
    }
    if (item.target === undefined || !deleted.has(item.target)) return item;
    const next = { ...item };
    delete next.target;
    cleared.push(`${own(agent, item)} no longer targets ${agentName(nodes, item.target)}.`);
    return next;
  }

  function clearQueue(queue: readonly QueueItem[], agent: string): readonly QueueItem[] {
    const next = queue.flatMap((item, index): QueueItem[] => {
      if (isIf(item)) {
        const checked = checkedBy(queue, index);
        if (
          item.if.kind !== 'freeText' &&
          item.if.kind !== 'usageAbove' &&
          checked &&
          gone(agent, checked.id)
        ) {
          removed(agent, item);
          cleared.push(`${own(agent, item)} was removed because the task it checked was removed.`);
          return [];
        }
        const then = item.then.flatMap((inner) => {
          const kept = clearLeaf(inner, agent);
          return kept ? [kept] : [];
        });
        if (sameItems(then, item.then)) return [item];
        if (then.length) return [{ ...item, then }];
        removed(agent, item);
        cleared.push(`${own(agent, item)} was removed because it has no steps left.`);
        return [];
      }
      if (isRepeat(item)) {
        const repeat = item.repeat.flatMap((inner) => {
          const kept = clearLeaf(inner, agent);
          return kept ? [kept] : [];
        });
        const { until } = item;
        const lostLeader = isRepeatEnds(until) && gone(until.agent, until.item);
        const checked = checkedBy(item.repeat, item.repeat.length) ?? checkedBy(queue, index);
        const lostCondition =
          until.kind !== 'repeatEnds' &&
          until.kind !== 'freeText' &&
          checked !== undefined &&
          gone(agent, checked.id);
        if (sameItems(repeat, item.repeat) && !lostLeader && !lostCondition) return [item];
        if (repeat.length === 0) {
          removed(agent, item);
          cleared.push(`${own(agent, item)} was removed because it has no items left.`);
          return [];
        }
        if (lostLeader || lostCondition) {
          removed(agent, item, false);
          cleared.push(
            lostLeader && isRepeatEnds(until)
              ? `${own(agent, item)} no longer follows ${reference(until.agent, until.item)}; its remaining items run once.`
              : `${own(agent, item)} no longer checks its removed last task; its remaining items run once.`,
          );
          return repeat;
        }
        return [{ ...item, repeat }];
      }
      if (isApproval(item)) return [item];
      const kept = clearLeaf(item, agent);
      return kept ? [kept] : [];
    });
    return sameItems(queue, next) ? queue : next;
  }

  let current = nodes;
  for (;;) {
    let changed = false;
    const next: N[] = [];
    for (const node of current) {
      if (node.type === 'frame' || deleted.has(node.id) || !node.data.queue) {
        next.push(node);
        continue;
      }
      const queue = clearQueue(node.data.queue, node.id);
      if (queue === node.data.queue) next.push(node);
      else {
        changed = true;
        next.push({ ...node, data: { ...node.data, queue } });
      }
    }
    if (!changed) return { nodes: current, cleared };
    current = next;
  }
}

function sameItems(a: readonly QueueItem[], b: readonly QueueItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** The item's position in the original queue, before any removals shift its neighbours. */
function itemName(nodes: readonly NodeLike[], agent: string, id: string): string {
  const queue = nodes.find((node) => node.id === agent)?.data.queue ?? [];
  for (const [index, item] of queue.entries()) {
    const position = String(index + 1);
    if (item.id === id) return `${kind(item)} ${position}`;
    const inner = isRepeat(item) ? item.repeat : isIf(item) ? item.then : [];
    const at = inner.findIndex((one) => one.id === id);
    const found = inner[at];
    if (found)
      return `${kind(found)} ${String(at + 1)} in ${isRepeat(item) ? 'repeat' : 'If'} ${position}`;
  }
  return 'removed item';
}

function kind(item: QueueItem): string {
  return isMessage(item)
    ? 'message'
    : isWait(item)
      ? 'wait'
      : isRepeat(item)
        ? 'repeat'
        : isIf(item)
          ? 'If'
          : isDelay(item)
            ? 'delay'
            : isApproval(item)
              ? 'OK'
              : 'step';
}
