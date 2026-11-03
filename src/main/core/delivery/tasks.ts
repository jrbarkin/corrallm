import { isContinuation, isOpenAsk } from '../../../shared/model/messages';
import type { Message } from '../../../shared/model/messages';
import type { Verdict } from '../../../shared/model/results';
import type { TaskMessage } from '../../../shared/session';
import type { RunTasks } from '../engine/run/runner';
import { isActive, sentByRun } from './messages';
import type { MessageStore } from './messages';

/*
 * What a canvas's mailbox holds of a queue task's attempt (B21 Design §9.2 C7, C8), read from its
 * rows alone: the asks it made (their `ask` column naming it), the continuations their settlements
 * send its agent (`task` naming it), its own sends (the run's), and the result its agent reported
 * with `complete`. The open asks are the durable state: the run's checkpoint keeps no copy, and a
 * restart derives from these rows whether an attempt waits, as the canvas opens.
 */

/** The told key a result record is kept with: one per attempt. */
export const resultKey = (attempt: string): string => `result:${attempt}`;

/** Whether `message` is one of attempt `task`'s, as its `task` names it. */
function of(message: Message, task: TaskMessage): boolean {
  return (
    message.task?.attempt === task.attempt &&
    message.task.agent === task.agent &&
    message.task.item === task.item
  );
}

/** Attempt `task`'s open asks, in the store's order. */
export function openAsksOf(store: MessageStore, task: TaskMessage): Message[] {
  return store.all().filter((message) => {
    if (!isOpenAsk(message) || message.ask?.type !== 'question') return false;
    const owned = message.ask.task;
    return (
      owned?.attempt === task.attempt && owned.owner === task.agent && owned.item === task.item
    );
  });
}

/** The continuations attempt `task`'s asks sent its agent, in the store's order. */
export function continuationsOf(store: MessageStore, task: TaskMessage): Message[] {
  return store.all().filter((message) => isContinuation(message) && of(message, task));
}

/**
 * Whether attempt `task` waits on its asks: one is open, or a continuation of it is yet to end
 * (waiting, being delivered, or its turn going on).
 */
export function waitsOn(store: MessageStore, task: TaskMessage): boolean {
  return (
    openAsksOf(store, task).length > 0 ||
    continuationsOf(store, task).some((message) => isActive(message))
  );
}

/** The verdict attempt `task`'s agent reported with `complete`, if it did. */
export function reportedOf(store: MessageStore, task: TaskMessage): Verdict | undefined {
  const result = store.toldAs(resultKey(task.attempt));
  return result?.kind === 'result' && of(result, task) ? result.verdict : undefined;
}

/**
 * What attempt `task`'s rows say of it, running as the run is held or restored (RunTasks.recover):
 * it waits, its own turn over (its send replied) and none of its continuations in flight or cut
 * off; else whether an answer had reached its agent (a continuation in flight, or cut off).
 */
export function recoveredOf(
  store: MessageStore,
  task: TaskMessage,
): { waiting: true } | { waiting: false; answered: boolean } {
  const continuations = continuationsOf(store, task);
  const answered = continuations.some(
    ({ state }) => state === 'delivering' || state === 'delivered' || state === 'unresolved',
  );
  // Its own turn is over once its send is replied, or pruned since, settled: a send in flight or
  // cut off is kept until it is settled, and none ends unsent with its attempt still running.
  const over = store
    .all()
    .every((message) => !sentByRun(message) || !of(message, task) || message.state === 'replied');
  return !answered && over && waitsOn(store, task)
    ? { waiting: true }
    : { waiting: false, answered };
}

/**
 * The run's view of a canvas's mailbox (RunIO.tasks): its rows, and `interrupt`, which takes back a
 * stopped attempt's continuation in flight (delivery's; none before delivery starts).
 */
export function mailboxTasks(
  store: MessageStore,
  interrupt: (task: TaskMessage) => void = () => undefined,
): RunTasks {
  return {
    waits: (task) => waitsOn(store, task),
    reported: (task) => reportedOf(store, task)?.outcome,
    recover: (task) => recoveredOf(store, task),
    interrupt,
  };
}
