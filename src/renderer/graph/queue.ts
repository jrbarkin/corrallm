/**
 * A step: an action, named as its agent names it, done to the node `target` (an id), or without
 * one to the node whose queue it is in.
 */
export interface QueueStep {
  id: string;
  action: string;
  target?: string;
}

/**
 * A message: text the user passes an agent as part of the queue. It goes to the queue's own agent,
 * or (`target`, an id) to another one, such as the head of a group.
 */
export interface QueueMessage {
  id: string;
  message: string;
  target?: string;
}

/**
 * What an if-then checks before it runs its steps: one of `CONDITIONS`, or (`freeText`) a condition
 * in the user's own words, passed to the agent to judge.
 */
export type Condition =
  | { kind: 'succeeded' }
  | { kind: 'failed' }
  | { kind: 'outputContains'; text: string }
  | { kind: 'timedOut' }
  | { kind: 'freeText'; text: string };

/** Runs its steps (`then`: actions and messages) only when its condition (`if`) holds. */
export interface QueueIf {
  id: string;
  if: Condition;
  then: (QueueStep | QueueMessage)[];
}

/**
 * What a wait waits for: an agent (`agent`, an id) to finish its whole queue, or, with `item` (the
 * id of an item in that agent's queue), to have done that item.
 */
export interface WaitTarget {
  agent: string;
  item?: string;
}

export function sameTarget(a: WaitTarget, b: WaitTarget): boolean {
  return a.agent === b.agent && a.item === b.item;
}

/** A wait's targets with the one at `index` now `target` (and no target twice). */
export function chooseTarget(
  waitFor: readonly WaitTarget[],
  index: number,
  target: WaitTarget,
): WaitTarget[] {
  return waitFor
    .map((t, i) => (i === index ? target : t))
    .filter((t, i, all) => all.findIndex((u) => sameTarget(u, t)) === i);
}

/**
 * A time: how long (`seconds`, whole, 1 to MAX_SECONDS, counted from when the queue reaches it), or
 * (`at`, "HH:MM", 24-hour, local) the next time the clock shows that after the queue reaches it.
 * Parsed and put in words by time.ts.
 */
export type Time = { seconds: number } | { at: string };

/** The longest a length can be: 7 days, in seconds. */
export const MAX_SECONDS = 7 * 24 * 60 * 60;

/**
 * A wait: the queue stops here until everything in `waitFor` is done (see WaitTarget). Naming
 * several makes a join: the queue goes on once the last of them is. Waits sit in the queue itself,
 * not in an if-then.
 */
export interface QueueWait {
  id: string;
  waitFor: WaitTarget[];
  /**
   * A time limit: once it passes, the queue goes on without what it waits for (the wait ran out of
   * time).
   */
  timeout?: Time;
}

/**
 * A delay: the queue stops here until its time has come, then goes on. Delays sit in the queue
 * itself, not in an if-then.
 */
export interface QueueDelay {
  id: string;
  delay: Time;
}

export type QueueItem = QueueStep | QueueMessage | QueueIf | QueueWait | QueueDelay;

export function isIf(item: QueueItem): item is QueueIf {
  return 'if' in item;
}

export function isWait(item: QueueItem): item is QueueWait {
  return 'waitFor' in item;
}

export function isDelay(item: QueueItem): item is QueueDelay {
  return 'delay' in item;
}

export function isMessage(item: QueueItem): item is QueueMessage {
  return 'message' in item;
}

/** A message with nothing written in it yet, such as the one a new agent's queue starts with. */
export function isBlank(item: QueueItem): boolean {
  return isMessage(item) && item.message.trim() === '';
}

/** A question an agent asks the user; `options`, if any, are the answers it suggests. */
export interface Question {
  id: string;
  text: string;
  options?: string[];
  answer?: string;
}

/** The conditions an if-then can check, as the dropdown offers them (besides free text). */
export const CONDITIONS = [
  { kind: 'succeeded', label: 'the previous step succeeded' },
  { kind: 'failed', label: 'the previous step failed' },
  { kind: 'outputContains', label: 'the output contains…' },
  { kind: 'timedOut', label: 'the wait ran out of time' },
] as const satisfies readonly { kind: Condition['kind']; label: string }[];

/**
 * The item the if-then at `index` in `queue` checks: the nearest one above it that is not a delay
 * (a delay only pauses, so the If after it checks what came before); undefined if there is none.
 */
export function checkedBy(queue: readonly QueueItem[], index: number): QueueItem | undefined {
  return queue.slice(0, Math.max(index, 0)).findLast((item) => !isDelay(item));
}

/**
 * Why the if-then at `index` in `queue` cannot hold where it sits, or undefined if it can: the
 * wait running out of time needs a wait right before it. The run skips such an if-then.
 */
export function unfit(queue: readonly QueueItem[], index: number): string | undefined {
  const item = queue[index];
  if (!item || !isIf(item) || item.if.kind !== 'timedOut') return undefined;
  const checked = checkedBy(queue, index);
  return checked && isWait(checked) ? undefined : 'No wait right before this If';
}
