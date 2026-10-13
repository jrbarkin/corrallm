import type { UsageBackend, UsageWindow } from '../../shared/usage';

/**
 * A step: an action, named as its agent names it, done to the node `target` (an id), or without
 * one to the node whose queue it is in. `instruction`: what it is to do, in the user's words (what
 * to run, what to read); a connected agent is told it with the step (a slash command takes it as
 * its arguments: run/turns.ts), a simulated one ignores it. `expect`: 'fails' for a step meant to
 * fail (tests written to fail first: red before green), which the run turns round (run/runner.ts):
 * failing is its success, passing its failure, so what reads how it went (an If, a repeat, a
 * wait) reads whether it went as expected. What the agent is asked does not change.
 */
export interface QueueStep {
  id: string;
  action: string;
  target?: string;
  instruction?: string;
  expect?: 'fails';
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
 * What an if-then checks before it runs its steps: one of `CONDITIONS`, (`freeText`) a condition
 * in the user's own words, for the agent to judge (a connected agent is asked, yes or no, in its
 * session: run/turns.ts), or (`usageAbove`) whether a backend's usage is over a share (1 to 99) of
 * a window, by its latest reading when the run reaches it (src/shared/usage.ts). The output it looks
 * in is what the agent replied in the checked task.
 */
export type Condition =
  | { kind: 'succeeded' }
  | { kind: 'failed' }
  | { kind: 'outputContains'; text: string }
  | { kind: 'timedOut' }
  | { kind: 'freeText'; text: string }
  | UsageAbove;

/** Whether a backend's usage is over `percent` of `window`. */
export interface UsageAbove {
  kind: 'usageAbove';
  backend: UsageBackend;
  window: UsageWindow;
  percent: number;
}

/** Runs its steps (`then`: actions and messages) only when its condition (`if`) holds. */
export interface QueueIf {
  id: string;
  if: Condition;
  then: (QueueStep | QueueMessage)[];
}

/**
 * What a wait waits for: an agent (`agent`, an id) to finish its whole queue, or, with `item` (the
 * id of an item in that agent's queue, or in a repeat in it), to have done that item. A step in a
 * repeat is done round by round: a wait in a repeat waits for it in the same round, and a wait
 * outside one waits for its repeat to end.
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
 * A time: how long (`seconds`, whole, 1 to MAX_SECONDS, counted from when the queue reaches it),
 * (`at`, "HH:MM", 24-hour, local) the next time the clock shows that after the queue reaches it, or
 * (UsageReset) when a backend's usage window resets, by its latest reading when the queue reaches
 * it. Parsed and put in words by time.ts.
 */
export type Time = { seconds: number } | { at: string } | UsageReset;

/** When a backend's usage window (`resets`) resets, as its latest reading says. */
export interface UsageReset {
  resets: UsageWindow;
  backend: UsageBackend;
}

export function isUsageReset(time: Time): time is UsageReset {
  return 'resets' in time;
}

/** The longest a length can be: 7 days, in seconds. */
export const MAX_SECONDS = 7 * 24 * 60 * 60;

/**
 * A wait: the queue stops here until everything in `waitFor` is done (see WaitTarget). Naming
 * several makes a join: the queue goes on once the last of them is. Waits sit in the queue itself,
 * or in a repeat (where a wait for a step in another repeat waits for that round of it), not in an
 * if-then.
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
 * itself, or in a repeat (counted afresh each round), not in an if-then.
 */
export interface QueueDelay {
  id: string;
  delay: Time;
}

/**
 * An OK: the queue holds here until the user decides about the work before it (`approve`: what
 * they check, in their words, e.g. "the spec in SPEC.md"; '' for the work before it). They approve
 * and the queue goes on; ask for changes (a note the queue's own agent gets, after which it asks
 * again); or stop the queue here. OKs sit in the queue itself, not in an if-then or a repeat.
 */
export interface QueueApproval {
  id: string;
  approve: string;
}

/** What a repeat holds: steps, messages, waits and delays (no if-thens, repeats or OKs). */
export type RepeatedItem = QueueStep | QueueMessage | QueueWait | QueueDelay;

/** Another agent's repeat (its agent, and its id there): a repeat ending with it goes round with it. */
export interface RepeatEnds {
  kind: 'repeatEnds';
  agent: string;
  item: string;
}

/**
 * When a repeat stops: a condition (any but timedOut and usageAbove) of each round's last task
 * that ran, or another agent's repeat ending.
 */
export type Until = Exclude<Condition, { kind: 'timedOut' | 'usageAbove' }> | RepeatEnds;

/** The most rounds a repeat runs unattended. */
export const MAX_ROUNDS = 20;

/**
 * A repeat: runs `repeat` in rounds; after each it stops if `until` holds, else runs again, up to
 * `rounds` in all; then asks the user ('ask': one more round, or go on) or goes on having failed
 * ('goOn'). Following another repeat (`until` a RepeatEnds, its leader), it runs as many rounds as
 * that one, each once the leader has gone on to the next, and ends with it; its `rounds` and
 * `otherwise` are kept, but unused. Repeats sit in the queue itself, not in an if-then or another
 * repeat.
 */
export interface QueueRepeat {
  id: string;
  repeat: RepeatedItem[];
  until: Until;
  rounds: number;
  otherwise: 'ask' | 'goOn';
}

export type QueueItem =
  QueueStep | QueueMessage | QueueIf | QueueWait | QueueDelay | QueueApproval | QueueRepeat;

export function isIf(item: QueueItem): item is QueueIf {
  return 'if' in item;
}

export function isWait(item: QueueItem): item is QueueWait {
  return 'waitFor' in item;
}

export function isDelay(item: QueueItem): item is QueueDelay {
  return 'delay' in item;
}

export function isApproval(item: QueueItem): item is QueueApproval {
  return 'approve' in item;
}

export function isRepeat(item: QueueItem): item is QueueRepeat {
  return 'repeat' in item;
}

export function isRepeatEnds(until: Until): until is RepeatEnds {
  return until.kind === 'repeatEnds';
}

/** A queue's items, each repeat followed by the items it holds (not those of if-thens). */
export function withRepeated(queue: readonly QueueItem[]): QueueItem[] {
  return queue.flatMap((item): QueueItem[] => (isRepeat(item) ? [item, ...item.repeat] : [item]));
}

/**
 * An item by id: at the top level of a queue, or inside a repeat (or an if-then) in it; with the
 * repeat holding it, if one does.
 */
export function findItem(
  queue: readonly QueueItem[],
  id: string,
): { item: QueueItem; repeat?: QueueRepeat } | undefined {
  for (const item of queue) {
    if (item.id === id) return { item };
    if (isRepeat(item)) {
      const inner = item.repeat.find((q) => q.id === id);
      if (inner) return { item: inner, repeat: item };
    } else if (isIf(item)) {
      const step = item.then.find((q) => q.id === id);
      if (step) return { item: step };
    }
  }
  return undefined;
}

/**
 * Whether an item is a hold that only pauses (a delay, an OK): what reads the item before it (an
 * if-then, a wait for all of an agent's work) passes over it to the one above.
 */
export function isPause(item: QueueItem): item is QueueDelay | QueueApproval {
  return isDelay(item) || isApproval(item);
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

/** The conditions a repeat can stop on, as the dropdown offers them (besides free text). */
export const UNTIL_CONDITIONS = [
  { kind: 'succeeded', label: 'its last step succeeds' },
  { kind: 'failed', label: 'its last step fails' },
  { kind: 'outputContains', label: 'the output contains…' },
] as const satisfies readonly { kind: Until['kind']; label: string }[];

/**
 * The item the if-then at `index` in `queue` checks: the nearest one above it that is not a pause
 * (a delay or an OK only pauses, so the If after it checks what came before); undefined if there
 * is none.
 */
export function checkedBy(queue: readonly QueueItem[], index: number): QueueItem | undefined {
  return queue.slice(0, Math.max(index, 0)).findLast((item) => !isPause(item));
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
