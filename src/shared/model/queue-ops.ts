import { editAgent } from './agent-ops';
import type { CanvasDocument } from './canvas';
import type { PartyId } from './messages';
import {
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isWait,
  MAX_ROUNDS,
  sameTarget,
} from './queue';
import type { Condition, QueueChange, QueueEntry, QueueItem, Until } from './queue';
import { sameTime } from './time';
import type { Built } from './structure';

/** A neighbour in the item's own list; null, or no neighbour, puts it at the end. */
export type Neighbour =
  { before: string | null; after?: never } | { after: string | null; before?: never };

/**
 * Adds an item to the queue or a named container, minting ids and recording its text's author:
 * `by`, unless it is yours, which is no one's (`by` names only another party: provenance, which a
 * shared file may claim, never authority; nothing reads it to decide anything).
 */
export function add(
  doc: CanvasDocument,
  { agent, entry, into }: { agent: string; entry: QueueEntry; into?: string },
  by: PartyId,
  newId: () => string,
): Built<{ item?: string }> {
  let item: string | undefined;
  const changed = editAgent(doc, agent, (data) => {
    const queue = data.queue ?? [];
    const container = into === undefined ? undefined : queue.find((one) => one.id === into);
    if (into !== undefined && (!container || !accepts(container, entry))) return data;
    const added = authored(entry, by, newId);
    item = added.id;
    const next =
      into === undefined
        ? [...queue, added]
        : queue.map((one) => {
            if (one !== container) return one;
            if (isRepeat(one) && !isIf(added) && !isRepeat(added) && !isApproval(added))
              return { ...one, repeat: [...one.repeat, added] };
            if (isIf(one) && (isMessage(added) || 'action' in added))
              return { ...one, then: [...one.then, added] };
            return one;
          });
    return { ...data, queue: next };
  });
  return { next: changed.next, result: item === undefined ? {} : { item } };
}

/** Removes a named item wherever its list is, preserving all surviving items by reference. */
export function remove(
  doc: CanvasDocument,
  { agent, item }: { agent: string; item: string },
): Built {
  return lists(doc, agent, (queue) => queue.filter((one) => one.id !== item));
}

/** Moves within the item's own list, by a sibling's id rather than a stale numerical position. */
export function move(
  doc: CanvasDocument,
  { agent, item, ...where }: { agent: string; item: string } & Neighbour,
): Built {
  return lists(doc, agent, (queue) => {
    const moved = queue.find((one) => one.id === item);
    if (!moved) return queue;
    const neighbour = where.before ?? where.after;
    if (neighbour === item) return queue;
    const rest = queue.filter((one) => one !== moved);
    const at = neighbour == null ? rest.length : rest.findIndex((one) => one.id === neighbour);
    if (at < 0) return queue;
    const index = at + (where.after != null ? 1 : 0);
    return [...rest.slice(0, index), moved, ...rest.slice(index)];
  });
}

/**
 * Changes one field, recording a new author only when its authored text changes: `by`, or no one
 * for yours, which makes the text yours.
 */
export function update(
  doc: CanvasDocument,
  { agent, item, change }: { agent: string; item: string; change: QueueChange },
  by: PartyId,
): Built {
  const edit = <T extends QueueItem>(one: T): T => {
    if (one.id !== item) return one;
    const next = changeItem(one, change);
    return (next === one || !textChanged(one, next) ? next : authoredBy(next, by)) as T;
  };
  return lists(doc, agent, (queue) => queue.map(edit));
}

function changeItem(item: QueueItem, change: QueueChange): QueueItem {
  switch (change.kind) {
    case 'message':
      return isMessage(item) && item.message !== change.message
        ? { ...item, message: change.message }
        : item;
    case 'action':
      return 'action' in item && item.action !== change.action
        ? { ...item, action: change.action }
        : item;
    case 'instruction': {
      if (!('action' in item) || (item.instruction ?? '') === (change.instruction ?? ''))
        return item;
      const next = { ...item };
      if (!change.instruction) delete next.instruction;
      else next.instruction = change.instruction;
      return next;
    }
    case 'expect':
      return 'action' in item ? optional(item, 'expect', change.expect ?? undefined) : item;
    case 'target':
      return isMessage(item) || 'action' in item
        ? optional(item, 'target', change.target ?? undefined)
        : item;
    case 'condition':
      return isIf(item) && !equal(item.if, change.condition)
        ? { ...item, if: change.condition }
        : item;
    case 'waitFor':
      return isWait(item) &&
        change.waitFor.length &&
        !(
          item.waitFor.length === change.waitFor.length &&
          item.waitFor.every((target, i) => {
            const other = change.waitFor[i];
            return other !== undefined && sameTarget(target, other);
          })
        )
        ? { ...item, waitFor: change.waitFor }
        : item;
    case 'time': {
      if (isDelay(item))
        return change.time && !sameTime(item.delay, change.time)
          ? { ...item, delay: change.time }
          : item;
      if (!isWait(item) || (item.timeout && change.time && sameTime(item.timeout, change.time)))
        return item;
      return optional(item, 'timeout', change.time ?? undefined);
    }
    case 'approve':
      return isApproval(item) && item.approve !== change.approve
        ? { ...item, approve: change.approve }
        : item;
    case 'repeat': {
      if (!isRepeat(item)) return item;
      const next = {
        ...item,
        ...(change.until === undefined ? {} : { until: change.until }),
        ...(change.otherwise === undefined ? {} : { otherwise: change.otherwise }),
        rounds: Math.max(1, Math.min(MAX_ROUNDS, Math.round(change.rounds ?? item.rounds))),
      };
      return next.rounds === item.rounds &&
        next.otherwise === item.otherwise &&
        equal(next.until, item.until)
        ? item
        : next;
    }
  }
}

/** Runs a same-kind edit on each list; children stay in their existing container. */
function lists(
  doc: CanvasDocument,
  agent: string,
  change: <T extends QueueItem>(items: T[]) => T[],
): Built {
  return editAgent(doc, agent, (data) => {
    const before = data.queue ?? [];
    const next = change(before).map((item) => {
      if (isIf(item)) {
        const then = change(item.then);
        return same(item.then, then) ? item : { ...item, then };
      }
      if (isRepeat(item)) {
        const repeat = change(item.repeat);
        return same(item.repeat, repeat) ? item : { ...item, repeat };
      }
      return item;
    });
    return same(before, next) ? data : { ...data, queue: next };
  });
}

function authored(entry: QueueEntry, by: PartyId, newId: () => string): QueueItem {
  const mint = <T extends object>(entry: T) => {
    const body = { ...entry };
    Reflect.deleteProperty(body, 'id');
    Reflect.deleteProperty(body, 'by');
    return { id: newId(), ...(by === 'you' ? {} : { by }), ...body };
  };
  const item = mint(entry);
  if ('then' in item) return { ...item, then: item.then.map(mint) };
  if ('repeat' in item) return { ...item, repeat: item.repeat.map(mint) };
  return item;
}

/** `item` written by `by`: its author, or none, for yours. */
function authoredBy<T extends { by?: PartyId }>(item: T, by: PartyId): T {
  const next = { ...item };
  if (by === 'you') delete next.by;
  else next.by = by;
  return next;
}

function accepts(container: QueueItem, entry: QueueEntry): boolean {
  if ('if' in entry || 'repeat' in entry || 'approve' in entry) return false;
  return isRepeat(container) || (isIf(container) && ('message' in entry || 'action' in entry));
}

function optional<T extends QueueItem, K extends keyof T>(
  item: T,
  key: K,
  value: T[K] | undefined,
): T {
  if (item[key] === value) return item;
  const next = { ...item };
  if (value === undefined) Reflect.deleteProperty(next, key);
  else next[key] = value;
  return next;
}
function textChanged(a: QueueItem, b: QueueItem): boolean {
  if (isMessage(a) && isMessage(b)) return a.message !== b.message;
  if ('action' in a && 'action' in b)
    return a.action !== b.action || a.instruction !== b.instruction;
  if (isApproval(a) && isApproval(b)) return a.approve !== b.approve;
  const conditionA = isIf(a) ? a.if : isRepeat(a) ? a.until : undefined;
  const conditionB = isIf(b) ? b.if : isRepeat(b) ? b.until : undefined;
  return (
    (conditionA && 'text' in conditionA ? conditionA.text : undefined) !==
    (conditionB && 'text' in conditionB ? conditionB.text : undefined)
  );
}
function equal(a: Condition | Until, b: Condition | Until): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'outputContains':
      return b.kind === 'outputContains' && a.text === b.text && a.wholeLine === b.wholeLine;
    case 'freeText':
      return b.kind === 'freeText' && a.text === b.text;
    case 'usageAbove':
      return (
        b.kind === 'usageAbove' &&
        a.backend === b.backend &&
        a.window === b.window &&
        a.percent === b.percent
      );
    case 'repeatEnds':
      return b.kind === 'repeatEnds' && a.agent === b.agent && a.item === b.item;
    default:
      return true;
  }
}
function same(a: readonly QueueItem[], b: readonly QueueItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
