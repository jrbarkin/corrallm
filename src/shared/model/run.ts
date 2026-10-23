import type { ConnectionId } from '../adapter';
import type { UsageHold } from '../usage';
import type { PartyId } from './messages';

/**
 * How a task went. skipped: an if-then whose condition did not hold (or cannot, where it sits), an
 * empty message, or an empty repeat. timedOut: a wait that went on without what it waited for, its
 * time limit past (or the user said to go on). stopped: an OK the user stopped its queue at. A
 * repeat fails when it runs out of rounds and goes on (or the user says to go on).
 */
export type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'timedOut' | 'stopped';

/** A task held for inspection; its original identity and session stay available. */
export interface TaskProblem {
  kind: 'failed' | 'uncertain' | 'cancelled';
  reason: string;
  text: string;
  agent: string;
  /** An unresolved If/repeat judgment, decided separately from the task's outcome. */
  conditionKey?: string;
}

/** A concise execution record, without the session's tool transcript. */
export interface TaskAttempt {
  id: string;
  /** The cancelled/failed attempt the user explicitly retried. */
  retryOf?: string;
  /** The durable mailbox message for this attempt (B11); not its native CLI id. */
  messageId?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
  reason?: string;
  text?: string;
  message?: string;
}

/** Where a repeat is: the round it is on (or ended on), and how many rounds the user added. */
export interface Round {
  round: number;
  /** The rounds added by One more round, this run. */
  more?: number;
}

/** Where an agent's queue is, in a run. */
export interface AgentRun {
  /** Finish any active task, then hold this queue until this agent is explicitly resumed. */
  paused?: boolean;
  problem?: TaskProblem;
  attempts?: Readonly<Record<string, readonly TaskAttempt[]>>;
  /**
   * The task it is on: an item of its queue, a step of an if-then, or an item in a repeat (by id);
   * or a repeat itself, while it asks the user for more rounds.
   */
  current?: string;
  /**
   * running: doing its task (or, at an OK, the changes the user asked for). waiting: held by the
   * run, at a wait or a delay. asking: held for the user, at an OK or a repeat out of rounds, or
   * at a task whose session would not start (`refused`). stopped: stopped at an OK, or at a wait
   * for what was stopped. done: past the end of its queue.
   */
  status: 'running' | 'waiting' | 'asking' | 'stopped' | 'done';
  /**
   * While its task has no connection, or its session would not start: the destination, how it
   * ran, why it could not, and a connection to try.
   * An unavailable task stays unsent; otherwise its message waits in the session's queue.
   */
  refused?: { agent: string; connection: ConnectionId; text: string; switchTo?: ConnectionId };
  /** While held at a delay, or at a wait with a time limit: when that time comes (epoch ms). */
  until?: number;
  /**
   * How each task it has finished went, by id. A repeat's items: how they went in its round now
   * (a new round clears them).
   */
  outcomes: Readonly<Record<string, Outcome>>;
  /**
   * How each step expected to fail (QueueStep.expect) went against that, by id, once judged:
   * true, it failed, as expected (its outcome: succeeded); false, it passed (its outcome: failed).
   * Kept as long as its outcome is; none for a step whose turn failed, which ran neither way.
   */
  asExpected?: Readonly<Record<string, boolean>>;
  /** Each repeat its queue has reached this run, by id: its round. */
  rounds?: Readonly<Record<string, Round>>;
  /** The changes the user asked for at each OK this run, by its id, oldest first. */
  changes?: Readonly<Record<string, readonly string[]>>;
  /**
   * While the usage rule of the backend it spends holds it before its next task (`current`):
   * asking the user, or waiting for the window to reset (`until`).
   */
  usage?: UsageHold;
}

/**
 * A hold on an agent's or a group's queue (`id`), and the party that set it: a party releases only
 * its own, and you any (Core Server rule R9).
 */
export interface PauseCause {
  id: string;
  by: PartyId;
}

/** What a pause, a kill or a release is aimed at: one agent, or every agent of a group. */
export type PauseTarget = { agent: string } | { group: string };

export interface Run {
  /** Individual and group hold causes; AgentRun.paused is their current membership projection. */
  individualPauses?: readonly PauseCause[];
  groupPauses?: readonly PauseCause[];
  /** Paused progress can resume; starting again is a separate deliberate action. */
  paused?: boolean;
  /**
   * Whether queues are running: an agent is doing a task, or held (by the run, or for the user).
   * Stopped queues keep no run going.
   */
  running: boolean;
  agents: Readonly<Record<string, AgentRun>>;
}
