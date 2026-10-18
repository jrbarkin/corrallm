import type { MessageImage, TurnResult } from '../../session';
import { WINDOW_NAMES, windowNow } from '../../usage';
import type { ConnectionId, UsageBackendId } from '../../adapter';
import type { AgentNode, CanvasNode } from '../../model/canvas';
import type { PartyId } from '../../model/messages';
import type { UsageAction, UsageHold, UsageReading, UsageState } from '../../usage';
import { agentName, groupMembers, isGroup } from '../../model/queries';
import {
  findItem,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isPause,
  isRepeat,
  isRepeatEnds,
  isUsageReset,
  isWait,
  unfit,
} from '../../model/queue';
import type {
  Condition,
  QueueIf,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueStep,
  RepeatedItem,
  RepeatEnds,
  Time,
  WaitTarget,
} from '../../model/queue';
import { deadline } from '../../model/time';
import { readRun } from './checkpoint';
import type { SavedRun } from './checkpoint';
import { warningText } from '../../model/words';
import type { EngineCatalog } from '../catalog';
import {
  conditionQuestion,
  isCommand,
  replyContains,
  stepMessage,
  stepVerdict,
  yesOrNo,
} from './turns';

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
   * While its task has no connection, or its session would not start (an Agent SDK agent on a
   * Claude subscription): the destination, how it ran, why it could not, and a connection to try.
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

/**
 * What the user answers at a hold that waits for them: one of its choices (by key, as asks.ts
 * offers them), or a reply in their words, with the images they pasted into it.
 */
export type Answer = { choice: string } | { reply: string; images?: readonly MessageImage[] };

/** Why an agent's session would not start, as it said, and the connection that would. */
export interface Refusal {
  text: string;
  switchTo?: ConnectionId;
}

/**
 * How a turn the run started in an agent's session ended: whether it failed (or was interrupted,
 * or taken off the session's queue), and what the agent replied in it (its text, '' if none).
 */
export interface TurnEnd {
  failed: boolean;
  reply: string;
  result?: TurnResult;
}

/** What a run needs from its surroundings. */
export interface RunIO {
  /** Writes the current checkpoint out before an automated prompt leaves for a session. */
  beforeSend?: () => Promise<void>;
  /** Holds queued session dispatch without blocking a fresh manual console intervention. */
  hold?: (agentId: string, held: boolean) => void;
  /**
   * Sends a message (with images, if any) to an agent's session; `done` once the turn it starts
   * ends. `refused`, later, each time the session would not start while the message waits to go
   * (kept in its queue, sent once the agent runs another way). Returns a function that takes it
   * back: off the session's queue while it waits there, or interrupting its turn while that goes
   * on.
   */
  send: (
    agent: AgentNode,
    text: string,
    done: (turn: TurnEnd) => void,
    images?: readonly MessageImage[],
    refused?: (refusal: Refusal) => void,
    /** A typed reply at an OK or repeat: also appears as a manual Message row. */
    origin?: 'user',
    displayText?: string,
  ) => () => void;
  /** Tells the user something about the run, in an agent's session (a notice there). */
  tell: (agent: AgentNode, text: string) => void;
  /** Runs an agent another way: the connection the user chose for it, as its session would not start. */
  connect: (agent: AgentNode, connection: ConnectionId) => void;
  /** Runs `run` in `ms`; returns a function that cancels it. */
  later: (run: () => void, ms: number) => () => void;
  /** The time now (epoch ms): the only clock a run reads, for its delays and time limits. */
  now: () => number;
  /**
   * Every backend's latest usage reading and its usage rule (main's: src/main/usage.ts), read when
   * the run needs them: an If on usage, a wait for a usage window's reset, and the rules, checked
   * between tasks (and again whenever main tells a new reading: RunStore.usageChanged).
   */
  usage?: () => UsageState;
  /**
   * Whether corrallm can't read what a connected agent replies (its session said so: its CLI's
   * settings turn off the hooks that tell it), so the run takes nothing from its replies.
   */
  unheard?: (agent: AgentNode) => boolean;
  /** The locale the run tells times of day in (the host's): the runtime's own, when none. */
  locale?: string;
}

/**
 * The longest the run sleeps before it looks at the clock again while a delay or a time limit
 * holds an agent: a timer can fire late (a sleeping laptop) and the clock can be changed.
 */
const ALARM_MS = 60_000;

/**
 * Why the run did not send a message that starts with `prefix`, which the connection `name`d runs
 * as a shell command.
 */
const shellRefused = (prefix: string, name: string) =>
  `Not sent: it starts with "${prefix}", which ${name} runs as a shell command, without asking. Reword it, or type it in the agent’s terminal yourself.`;

/** Whether `text` starts with `prefix`, the text its recipient runs as a shell command, if any. */
const startsWith = (text: string, prefix: string | undefined): prefix is string =>
  prefix !== undefined && prefix !== '' && text.trimStart().startsWith(prefix);

/**
 * What a correction the user typed sends: their note, then what it corrects. A note that starts
 * with the recipient's shell prefix (`prefix`) is a shell command for its CLI's bash mode, sent
 * alone: the canvas's text after it would be run as part of it.
 */
const corrected = (note: string, task: string, prefix: string | undefined) =>
  startsWith(note, prefix) ? note : `${note}\n\n${task}`;

/**
 * What the run says when it waits for a usage window's reset that has never been read (the backend
 * named by `catalog`).
 */
const unread = (
  backend: UsageBackendId,
  window: keyof typeof WINDOW_NAMES,
  catalog: EngineCatalog,
) =>
  `${catalog.backendName(backend)}’s usage hasn’t been read yet, so the queue went on without waiting for its ${WINDOW_NAMES[window]} reset.`;

/** What the run says, once a run, when it can't read a connected agent's replies (RunIO.unheard). */
const UNHEARD =
  'corrallm can’t read this agent’s replies (its hooks are off). Steps wait in Needs you for a ' +
  'verdict; output checks and conditions in your words wait for your judgment.';

const IDLE: Run = { running: false, agents: {} };

// Checkpoints restore paused with in-flight prompts unresolved; only an explicit Retry replays
// submitted work. Native conversation history remains the source for inspecting its effects.

interface PendingSend {
  owner: string;
  destination: string;
  dispatch: () => void;
  withdraw: () => void;
}

interface PauseCauses {
  individual: PauseCause[];
  groups: PauseCause[];
  recorded: boolean;
}

/**
 * Runs every agent's queue: each agent works through its queue in order. A message goes to the
 * agent's session (delivery/mailbox.ts), or, aimed at another agent, to that agent's, and is done when the
 * turn it starts ends (failed, if that turn failed or was interrupted). Each agent's step
 * goes to its session too (turns.ts words it: a slash command as it is, a tool as an instruction
 * to use it that asks how it went), done when its turn ends, failed if the agent says so (a turn
 * that ends well may run tests that fail). A step expected to fail (QueueStep.expect) is turned
 * round once judged: failing is its success, passing its failure (a tool's turn that fails is no
 * verdict: it fails all the same).
 * A wait holds until what it waits for is done (a step, or all of an agent's work), or its time
 * limit passes; a delay holds until its time has come; an if-then runs its steps only if its
 * condition holds of the task before it. A connected agent's conditions are its own: whether the
 * output contains something is read from what it replied in that task's turn, and a condition in
 * the user's words is asked of it, in its session, yes or no.
 * Delays and time limits are the run's own, on the real clock (`now`): no agent is asked to wait.
 * An OK holds until the user decides (`decide`): the queue goes on, the agent makes the changes
 * asked for and it asks again, or the queue stops there, and with it whatever waits on it. A
 * repeat runs what it holds in rounds, until its condition holds of a round's last task that ran,
 * at most its rounds; then it goes on having failed, or asks the user for one more round. A wait
 * in a repeat for a step in another repeat waits for it in the same round; a wait outside one, for
 * that repeat to end. A repeat that follows another goes round with it, and ends with it. Rounds,
 * like delays, are the run's: the agent is only sent each round's messages. Queues are read as
 * they run (`update` gives it the canvas's nodes as they change, src/shared/model/canvas.ts), so
 * edits take effect at once. What it knows of each agent's adapter (how it runs, what its steps
 * can name, the usage it spends) it reads in the catalog it is given (catalog.ts). Stop takes
 * back what the run sent that is still going (RunIO.send). A task whose session would not start
 * (an Agent SDK agent on a Claude subscription) neither fails nor goes on: its agent asks the user
 * to switch that agent to another connection (`decide`), and works again once it runs another way,
 * its session sending what it kept.
 */
export class RunStore {
  #run: Run = IDLE;
  #nodes: readonly CanvasNode[] = [];
  readonly #catalog: EngineCatalog;
  readonly #io: RunIO;
  readonly #listeners = new Set<() => void>();
  /** What cancels each timer set. */
  readonly #timers = new Map<() => void, { agent: string; token: object } | undefined>();
  /** The task each busy agent is doing, by a token that is this run's alone. */
  readonly #busy = new Map<string, object>();
  /** What takes back each message the run sent whose turn has not ended yet. */
  readonly #sent = new Map<object, PendingSend>();
  readonly #sessionHolds = new Set<string>();
  /** What each agent replied in the turn of each task it finished (by agent and task). */
  readonly #replies = new Map<string, string>();
  /**
   * Whether each if-then's condition held, once decided (by agent and if-then); and each repeat's,
   * at the end of each round (by agent, repeat and round).
   */
  readonly #held = new Map<string, boolean>();
  /** When each agent reached the delay or wait it is (or was) held at (by agent and item). */
  readonly #arrived = new Map<string, number>();
  /** The holds the user said to go on from (Go on now), by agent and item. */
  readonly #ended = new Set<string>();
  /** How each item in a repeat went in the rounds before the one it is on, by agent, item and round. */
  readonly #past = new Map<string, Outcome>();
  /** The one timer that wakes the run when the next delay or time limit comes. */
  #alarm: { at: number; cancel: () => void } | undefined;
  /**
   * When each hold until a usage window's reset comes (by agent and item), as its reading said when
   * the agent reached it, with the time it was for: the next window's reset, read meanwhile, does
   * not hold it again.
   */
  readonly #due = new Map<string, { time: string; at: number | undefined }>();
  /**
   * What the user decided where a usage rule held agents (by backend and window): go on, or wait
   * for the reset; for every agent on that backend, until the window resets (`until`).
   */
  readonly #usageDecided = new Map<string, { choice: 'goOn' | 'wait'; until: number }>();
  /** The windows (by backend, window and reset) whose rule has warned the user this run. */
  readonly #warned = new Set<string>();
  /** The agents the run said it can't read the replies of, this run. */
  readonly #toldUnheard = new Set<string>();
  readonly #observed = new Map<string, { owner: string; item: string; token: object }>();

  constructor(catalog: EngineCatalog, io: RunIO) {
    this.#catalog = catalog;
    this.#io = io;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The run: a new object after each change. */
  snapshot = (): Run => this.#run;

  checkpoint(): string {
    const saved: SavedRun = {
      version: 2,
      run: this.#run,
      replies: [...this.#replies],
      held: [...this.#held],
      arrived: [...this.#arrived],
      ended: [...this.#ended],
      past: [...this.#past],
      due: [...this.#due],
      usageDecided: [...this.#usageDecided],
      warned: [...this.#warned],
    };
    return JSON.stringify(saved);
  }

  restore(text: string): void {
    const saved = readRun(text);
    const causes = this.#pauseCauses(saved.run);
    for (const id of this.#pausedMembers(causes)) this.#hold(id, true);
    this.#cancel();
    this.#forget();
    for (const [key, value] of saved.replies) this.#replies.set(key, value);
    for (const [key, value] of saved.held) this.#held.set(key, value);
    for (const [key, value] of saved.arrived) this.#arrived.set(key, value);
    for (const key of saved.ended) this.#ended.add(key);
    for (const [key, value] of saved.past) this.#past.set(key, value);
    for (const [key, value] of saved.due) this.#due.set(key, value);
    for (const [key, value] of saved.usageDecided) this.#usageDecided.set(key, value);
    for (const key of saved.warned) this.#warned.add(key);
    const agents: Record<string, AgentRun> = {};
    for (const [id, at] of Object.entries(saved.run.agents)) {
      if (
        at.status === 'running' &&
        at.current !== undefined &&
        at.outcomes[at.current] === undefined
      ) {
        const node = this.#agents().find((n) => n.id === id);
        const item = node && findItem(node.data.queue ?? [], at.current)?.item;
        const condition = conditionKey(id, item, at.rounds);
        agents[id] = {
          ...at,
          status: 'asking',
          problem: {
            kind: 'uncertain',
            reason: 'interrupted',
            text: 'This task was in progress when the session ended. Inspect its native conversation before resolving or retrying.',
            agent: item && isMessage(item) ? (item.target ?? id) : id,
            ...(condition ? { conditionKey: condition } : {}),
          },
          ...(at.attempts
            ? {
                attempts: Object.fromEntries(
                  Object.entries(at.attempts).map(([task, attempts]) => [
                    task,
                    attempts.map((attempt) =>
                      attempt.status === 'running'
                        ? {
                            ...attempt,
                            status: 'uncertain' as const,
                            endedAt: this.#io.now(),
                            reason: 'interrupted',
                          }
                        : attempt,
                    ),
                  ]),
                ),
              }
            : {}),
        };
      } else agents[id] = at;
    }
    this.#run = {
      running: false,
      ...(resumable(agents, causes) ? { paused: true } : {}),
      agents,
      ...(causes.recorded
        ? { individualPauses: causes.individual, groupPauses: causes.groups }
        : {}),
    };
    this.#applyPauses();
    this.#set({ ...this.#run });
  }

  /** Runs every queue from the top. */
  start(): void {
    const causes = this.#pauseCauses();
    this.#cancel();
    this.#forget();
    this.#run = {
      running: true,
      agents: {},
      ...(causes.recorded
        ? { individualPauses: causes.individual, groupPauses: causes.groups }
        : {}),
    };
    this.#applyPauses();
    this.#settle(true);
  }

  /**
   * Stops where the queues are: no task goes on, and none starts. What the run sent to sessions
   * is taken back (off their queues, or their turns interrupted).
   */
  stop(): void {
    this.#interrupt(
      'cancelled',
      'The run was stopped. Inspect the session before retrying this task.',
    );
    this.#cancel();
    this.#halt();
  }

  /** Quitting/reloading holds in-flight work as unresolved, never as an automatic retry. */
  pause(): void {
    this.#interrupt(
      'uncertain',
      'The session was interrupted. Inspect its native conversation before resolving or retrying.',
    );
    this.#cancel();
    this.#halt();
  }

  /** The run goes no further: paused, if it holds anything to resume (as a restored run is). */
  #halt(): void {
    const paused = resumable(this.#run.agents, this.#pauseCauses());
    this.#set({ ...this.#run, running: false, ...(paused ? { paused } : {}) });
  }

  resume(): void {
    if (!this.#run.paused || this.#run.running) return;
    this.#run = { ...this.#run, running: true, paused: false };
    for (const pending of this.#sent.values()) pending.dispatch();
    this.#settle(true);
  }

  /**
   * Lets the active task finish, then holds only this agent's queue and future incoming work: a
   * cause the party `by` set (you, unless said).
   */
  pauseAgent(id: string, by: PartyId = 'you'): void {
    if (!this.#addIndividualPause(id, by)) return;
    this.#publishControl();
  }

  /** Interrupts owned/received tasks, retaining their cancelled holds and the existing console. */
  killAgent(id: string, by: PartyId = 'you'): void {
    if (!this.#addIndividualPause(id, by)) return;
    this.#killMembers(new Set([id]));
    this.#publishControl();
  }

  /** Group causes are independent of individual and other containing-group causes. */
  pauseGroup(id: string, by: PartyId = 'you'): void {
    if (!this.#addGroupPause(id, by)) return;
    this.#publishControl();
  }

  /** Hold the whole group before any withdrawal can release queued work in another member. */
  killGroup(id: string, by: PartyId = 'you'): void {
    if (!this.#addGroupPause(id, by)) return;
    this.#killMembers(new Set(groupMembers(this.#nodes, id)));
    this.#publishControl();
  }

  /** Releases the group's pause: the party `by`'s own cause, or (you, unless said) every party's. */
  resumeGroup(id: string, by: PartyId = 'you'): void {
    const causes = this.#pauseCauses();
    const left = causes.groups.filter((cause) => !releases(cause, id, by));
    if (left.length === causes.groups.length) return;
    this.#writePauses(causes.individual, left);
    this.#releasePending();
    this.#publishControl();
  }

  /** The parties whose pauses hold `target` now (an agent's own, or a group's), oldest first. */
  pausedBy(target: PauseTarget): PartyId[] {
    const causes = this.#pauseCauses();
    const [id, held] =
      'agent' in target ? [target.agent, causes.individual] : [target.group, causes.groups];
    return held.flatMap((cause) => (cause.id === id ? [cause.by] : []));
  }

  #killMembers(members: ReadonlySet<string>): void {
    const affected = new Map(
      [...this.#busy].filter(([owner]) => {
        if (members.has(owner)) return true;
        const at = this.#run.agents[owner];
        const node = this.#agents().find((node) => node.id === owner);
        const item = at?.current && node && findItem(node.data.queue ?? [], at.current)?.item;
        return item && isMessage(item) && item.target !== undefined && members.has(item.target);
      }),
    );
    this.#interrupt(
      'cancelled',
      'This task was interrupted by Kill. Inspect its session before resolving or retrying.',
      new Set(affected.keys()),
    );
    for (const owner of affected.keys()) this.#busy.delete(owner);
    for (const [key, observed] of this.#observed)
      if (affected.has(observed.owner)) this.#observed.delete(key);
    for (const [cancel, holder] of this.#timers) {
      if (holder && affected.get(holder.agent) === holder.token) {
        this.#timers.delete(cancel);
        cancel();
      }
    }
    for (const [key, pending] of this.#sent) {
      if (members.has(pending.owner) || members.has(pending.destination)) {
        this.#sent.delete(key);
        pending.withdraw();
      }
    }
  }

  /**
   * Releases this agent, without replaying interrupted work or resuming a globally paused run: the
   * party `by`'s own cause, or (you, unless said) every party's.
   */
  resumeAgent(id: string, by: PartyId = 'you'): void {
    const causes = this.#pauseCauses();
    const left = causes.individual.filter((cause) => !releases(cause, id, by));
    if (left.length === causes.individual.length) return;
    this.#writePauses(left, causes.groups);
    this.#releasePending();
    this.#publishControl();
  }

  #addIndividualPause(id: string, by: PartyId): boolean {
    if (!this.#agents().some((node) => node.id === id)) return false;
    const causes = this.#pauseCauses();
    this.#writePauses([...causes.individual, { id, by }], causes.groups);
    return true;
  }

  #addGroupPause(id: string, by: PartyId): boolean {
    if (!isGroup(this.#nodes, id)) return false;
    const causes = this.#pauseCauses();
    this.#writePauses(causes.individual, [...causes.groups, { id, by }]);
    return true;
  }

  #writePauses(individual: readonly PauseCause[], groups: readonly PauseCause[]): void {
    this.#run = {
      ...this.#run,
      individualPauses: distinct(individual),
      groupPauses: distinct(groups),
    };
    this.#applyPauses();
  }

  #pauseCauses(run = this.#run): PauseCauses {
    const present = new Set(this.#agents().map((node) => node.id));
    return {
      individual: distinct(run.individualPauses ?? []).filter(({ id }) => present.has(id)),
      groups: distinct(run.groupPauses ?? []).filter(({ id }) => isGroup(this.#nodes, id)),
      recorded: run.individualPauses !== undefined || run.groupPauses !== undefined,
    };
  }

  #pausedMembers(causes: PauseCauses): Set<string> {
    return new Set([
      ...causes.individual.map(({ id }) => id),
      ...causes.groups.flatMap(({ id }) => groupMembers(this.#nodes, id)),
    ]);
  }

  /** Recompute the aggregate flag from current membership; it is never a hold cause itself. */
  #applyPauses(): boolean {
    const previous = this.#run;
    const before = JSON.stringify(this.#run);
    const causes = this.#pauseCauses();
    const paused = this.#pausedMembers(causes);
    const present = new Set(this.#agents().map((node) => node.id));
    const agents = Object.fromEntries(
      Object.entries(this.#run.agents).filter(([id, at]) => !at.paused || present.has(id)),
    );
    for (const id of present) {
      const at = agents[id];
      if (paused.has(id))
        agents[id] = { ...(at ?? { status: 'waiting', outcomes: {} }), paused: true };
      else if (at?.paused) {
        const next = { ...at };
        delete next.paused;
        agents[id] = next;
      }
    }
    this.#run = {
      ...this.#run,
      agents,
      ...(causes.recorded
        ? { individualPauses: causes.individual, groupPauses: causes.groups }
        : {}),
    };
    // Install all newly inherited holds before releasing any old hold or interrupting a turn.
    for (const id of present) if (paused.has(id)) this.#hold(id, true);
    for (const id of this.#sessionHolds) if (!paused.has(id)) this.#hold(id, false);
    const changed = before !== JSON.stringify(this.#run);
    if (!changed) this.#run = previous;
    return changed;
  }

  #releasePending(): void {
    if (this.#run.running) for (const pending of this.#sent.values()) pending.dispatch();
  }

  #hold(id: string, held: boolean): void {
    if (this.#sessionHolds.has(id) === held) return;
    if (held) this.#sessionHolds.add(id);
    else this.#sessionHolds.delete(id);
    this.#io.hold?.(id, held);
  }

  #publishControl(): void {
    if (this.#run.running) this.#settle(true);
    else this.#set({ ...this.#run });
  }

  /** Forgets the run, as for another canvas. */
  reset(): void {
    this.#cancel();
    this.#forget();
    this.#set(IDLE);
    for (const id of this.#sessionHolds) this.#hold(id, false);
  }

  /**
   * Ends now the hold an agent is at (Go on now): a delay, as if its time had come; a wait, as if
   * its time limit had passed. Only while the run holds that agent at that item (`item`), so a
   * click meant for one hold never ends the next.
   */
  goOn(agent: string, item: string): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || at?.paused || at?.status !== 'waiting' || at.current !== item) return;
    if (at.usage) {
      // Waiting for a usage window's reset, as its rule says: every agent on it goes on, until then.
      this.#decideUsage(at.usage, 'goOn');
      this.#settle(false);
      return;
    }
    // A repeat that follows another ends with it, not before.
    const queue = this.#agents().find((n) => n.id === agent)?.data.queue ?? [];
    const held = findItem(queue, item)?.item;
    if (!held || isRepeat(held)) return;
    this.#ended.add(JSON.stringify([agent, item]));
    this.#settle(false);
  }

  /**
   * Answers the hold an agent is at for the user (`item`). At an OK: `{ choice: 'approve' }`, its
   * queue goes on, and so do waits for it; `{ choice: 'stop' }`, its queue stops there, and with it
   * every wait for it, for what comes after it, or for all of its agent's work; `{ reply }`, the
   * changes the user asks for, sent as they are (trimmed, with the images pasted into them; with
   * neither, nothing is asked) to the agent's session, and once that turn ends, it asks again. At a
   * repeat out of rounds: `{ choice: 'more' }` runs one more round; `{ choice: 'goOn' }` ends it as
   * failed, and its queue goes on; `{ reply }` sends what to try next to the agent (not waited
   * for), then runs one more round. Where its task's session would not start: `{ choice: 'switch' }`
   * switches that session's agent to the connection it offered (RunIO.connect). Only while the
   * run holds that agent at that item for the user, so a second click, a stale card or an answer
   * after Stop does nothing.
   */
  decide(agent: string, item: string, answer: Answer): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || at?.paused || at?.status !== 'asking' || at.current !== item) return;
    if (at.refused) {
      const { refused } = at;
      const to = this.#agents().find((n) => n.id === refused.agent);
      if (
        to &&
        refused.switchTo !== undefined &&
        'choice' in answer &&
        answer.choice === 'switch'
      ) {
        this.#io.connect(to, refused.switchTo);
      }
      return;
    }
    const node = this.#agents().find((n) => n.id === agent);
    const held = node && findItem(node.data.queue ?? [], item)?.item;
    if (!node || !held) return;
    if (at.problem) {
      if (at.problem.conditionKey !== undefined) {
        if (!('choice' in answer) || !['retry', 'yes', 'no', 'stop'].includes(answer.choice))
          return;
        const cleared = { ...at };
        delete cleared.problem;
        this.#run = { ...this.#run, agents: { ...this.#run.agents, [agent]: cleared } };
        if (answer.choice === 'retry') this.#held.delete(at.problem.conditionKey);
        else if (answer.choice === 'stop') this.#record(agent, item, 'stopped');
        else this.#held.set(at.problem.conditionKey, answer.choice === 'yes');
        this.#settle(true);
        return;
      }
      if ('reply' in answer) {
        this.#retry(node, held, answer.reply.trim(), answer.images);
      } else if (answer.choice === 'retry') {
        this.#retry(node, held);
      } else if (
        answer.choice === 'resolve' ||
        answer.choice === 'continue' ||
        answer.choice === 'stop'
      ) {
        const outcome =
          answer.choice === 'resolve'
            ? 'succeeded'
            : answer.choice === 'stop'
              ? 'stopped'
              : at.problem.kind === 'cancelled'
                ? 'cancelled'
                : 'failed';
        const cleared = { ...at };
        delete cleared.problem;
        this.#run = { ...this.#run, agents: { ...this.#run.agents, [agent]: cleared } };
        this.#record(agent, item, outcome);
        this.#settle(true);
      }
      return;
    }
    if (at.usage) {
      this.#answerUsage(node, at.usage, item, answer);
      return;
    }
    if (isRepeat(held)) {
      this.#decideRounds(node, at, held, answer);
      return;
    }
    if (!isApproval(held)) return;
    if ('reply' in answer) {
      this.#askForChanges(node, at, item, answer.reply.trim(), answer.images ?? []);
      return;
    }
    const outcome =
      answer.choice === 'approve' ? 'succeeded' : answer.choice === 'stop' ? 'stopped' : undefined;
    if (outcome === undefined) return;
    this.#record(agent, item, outcome);
    this.#settle(true);
  }

  /**
   * The canvas's nodes as they are now: a run goes on with new work, and past waits for what is
   * gone; an agent whose session would not start, once it runs another way.
   */
  update(nodes: readonly CanvasNode[]): void {
    this.#nodes = nodes;
    const changed = this.#applyPauses();
    this.#releasePending();
    if (this.#run.running) this.#settle(this.#unrefuse() || changed);
    else if (changed) this.#set({ ...this.#run });
  }

  /**
   * Main told a new usage reading or rule (RunIO.usage): the rules are checked again for every
   * agent between tasks, and holds they no longer call for end.
   */
  usageChanged(): void {
    if (this.#run.running) this.#settle(false);
  }

  /** A prompt typed in the held task's own console is an observed attempt, not another send. */
  observeSubmission(
    session: string,
    message: string,
    text: string,
  ): { agent: string; item: string } | undefined {
    if (!this.#run.running && !this.#run.paused) return undefined;
    const held = Object.entries(this.#run.agents).filter(
      ([owner, at]) =>
        at.problem?.agent === session &&
        at.problem.conditionKey === undefined &&
        at.current !== undefined &&
        !this.#busy.has(owner),
    );
    if (held.length !== 1) return undefined;
    const pair = held[0];
    if (!pair) return undefined;
    const [owner, at] = pair;
    if (!at.current || this.#busy.has(owner)) return undefined;
    const token = {};
    this.#busy.set(owner, token);
    const next = {
      ...at,
      status: 'running' as const,
      attempts: this.#attempts(at, at.current, text),
    };
    delete next.problem;
    this.#observed.set(JSON.stringify([session, message]), { owner, item: at.current, token });
    this.#set({ ...this.#run, agents: { ...this.#run.agents, [owner]: next } });
    return { agent: owner, item: at.current };
  }

  observeEnd(session: string, message: string, reply: string, result: TurnResult): void {
    const key = JSON.stringify([session, message]);
    const observed = this.#observed.get(key);
    this.#observed.delete(key);
    if (!observed) return;
    const node = this.#agents().find((n) => n.id === observed.owner);
    const task = node && findItem(node.data.queue ?? [], observed.item)?.item;
    if (!task || isIf(task) || isRepeat(task) || isWait(task) || isDelay(task) || isApproval(task))
      return;
    this.#taskEnded(observed.owner, task, observed.token, {
      reply,
      failed: result.status !== 'completed',
      result,
    });
  }

  #attempts(
    at: AgentRun | undefined,
    item: string,
    message?: string,
  ): NonNullable<AgentRun['attempts']> {
    const attempt: TaskAttempt = {
      id: crypto.randomUUID(),
      startedAt: this.#io.now(),
      status: 'running',
      ...(message ? { message } : {}),
    };
    return { ...at?.attempts, [item]: [...(at?.attempts?.[item] ?? []), attempt] };
  }

  #endAttempt(
    agent: string,
    item: string,
    status: TaskAttempt['status'],
    reason?: string,
    text?: string,
  ): void {
    const at = this.#run.agents[agent];
    const attempts = at?.attempts?.[item];
    if (!at || !attempts?.length) return;
    const next = attempts.map((attempt, index) =>
      index === attempts.length - 1 && attempt.status === 'running'
        ? {
            ...attempt,
            endedAt: this.#io.now(),
            status,
            ...(reason ? { reason } : {}),
            ...(text ? { text } : {}),
          }
        : attempt,
    );
    this.#run = {
      ...this.#run,
      agents: {
        ...this.#run.agents,
        [agent]: { ...at, attempts: { ...at.attempts, [item]: next } },
      },
    };
  }

  #interrupt(
    kind: TaskProblem['kind'],
    text: string,
    owners: ReadonlySet<string> = new Set(this.#busy.keys()),
  ): void {
    for (const agent of owners) {
      const at = this.#run.agents[agent];
      if (!at?.current) continue;
      this.#endAttempt(agent, at.current, kind, 'interrupted', text);
      const updated = { ...(this.#run.agents[agent] ?? at) };
      delete updated.refused;
      const node = this.#agents().find((n) => n.id === agent);
      const item = node && findItem(node.data.queue ?? [], at.current)?.item;
      const destination = item && isMessage(item) ? (item.target ?? agent) : agent;
      const condition = conditionKey(agent, item, at.rounds);
      this.#run = {
        ...this.#run,
        agents: {
          ...this.#run.agents,
          [agent]: {
            ...updated,
            status: 'asking',
            problem: {
              kind,
              text,
              reason: 'interrupted',
              agent: destination,
              ...(condition ? { conditionKey: condition } : {}),
            },
          },
        },
      };
    }
  }

  /** Whether the queue was written for task `item` failing: an If it failed after it, or a repeat. */
  #handlesFailure(agent: string, item: string): boolean {
    const queue = this.#agents().find((n) => n.id === agent)?.data.queue ?? [];
    const found = findItem(queue, item);
    if (found?.repeat) return true;
    const container = queue.findIndex(
      (entry) =>
        entry.id === item || (isIf(entry) && entry.then.some((inner) => inner.id === item)),
    );
    const next = queue.slice(container + 1).find((entry) => !isPause(entry));
    return container !== -1 && next !== undefined && isIf(next) && next.if.kind === 'failed';
  }

  #retry(node: AgentNode, task: QueueItem, note?: string, images?: readonly MessageImage[]): void {
    const at = this.#run.agents[node.id];
    if (!at || (note !== undefined && note === '' && !images?.length)) return;
    const cleared = { ...at };
    delete cleared.problem;
    this.#run = { ...this.#run, agents: { ...this.#run.agents, [node.id]: cleared } };
    if (
      isMessage(task) ||
      (!isIf(task) && !isRepeat(task) && !isWait(task) && !isDelay(task) && !isApproval(task))
    ) {
      const next = this.#begin(
        node.id,
        task,
        { ...at.outcomes },
        note === undefined ? undefined : { note, images },
      );
      this.#set({
        ...this.#run,
        agents: {
          ...this.#run.agents,
          [node.id]: {
            ...next,
            ...(at.rounds ? { rounds: at.rounds } : {}),
            ...(at.changes ? { changes: at.changes } : {}),
          },
        },
      });
    } else {
      for (const key of this.#held.keys()) {
        const parts: unknown = JSON.parse(key);
        if (Array.isArray(parts) && parts[0] === node.id && parts[1] === task.id)
          this.#held.delete(key);
      }
      this.#settle(true);
    }
  }

  #agents(): AgentNode[] {
    return this.#nodes.filter((n): n is AgentNode => n.type === 'agent');
  }

  /** Moves every agent not busy with a task on as far as it can go, until none can. */
  #settle(changed: boolean): void {
    // Native console work can finish during a pause; retain its evidence without dispatching
    // queued work or releasing waits until the user resumes the run.
    if (!this.#run.running && this.#run.paused) {
      if (changed) this.#set({ ...this.#run });
      return;
    }
    const nodes = this.#agents();
    let agents: Record<string, AgentRun> = Object.fromEntries(
      nodes.flatMap((n) => {
        const run = this.#run.agents[n.id];
        return run ? [[n.id, run]] : [];
      }),
    );
    let moved = changed || Object.keys(agents).length !== Object.keys(this.#run.agents).length;
    const now = this.#io.now();
    for (let again = true; again;) {
      again = false;
      for (const node of nodes) {
        if (this.#busy.has(node.id)) continue;
        const before = agents[node.id];
        const after = this.#advance(node, before ?? { status: 'done', outcomes: {} }, agents, now);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        agents = { ...agents, [node.id]: after };
        again = true;
        moved = true;
      }
    }
    const running =
      this.#busy.size > 0 ||
      Object.values(agents).some((run) => run.status === 'waiting' || run.status === 'asking');
    if (moved || running !== this.#run.running) this.#set({ ...this.#run, running, agents });
    this.#arm(now);
  }

  /**
   * Where an agent not busy with a task goes next: its next task, a hold (a wait, a delay, an OK, a
   * repeat out of rounds), a stop, or done. Its repeats' rounds, and what the user asked for at its
   * OKs, go with it.
   */
  #advance(
    node: AgentNode,
    run: AgentRun,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun {
    if (run.paused) {
      if (run.problem || run.status === 'stopped') return run;
      const done = (node.data.queue ?? []).every((item) => run.outcomes[item.id] !== undefined);
      const next: AgentRun = { ...run, status: done ? 'done' : 'waiting' };
      if (run.current && run.outcomes[run.current] !== undefined) delete next.current;
      return next;
    }
    if (run.problem && run.current && findItem(node.data.queue ?? [], run.current)) return run;
    const rounds: Record<string, Round> = { ...run.rounds };
    const next = this.#next(node, run.outcomes, rounds, agents, now);
    // How a step went against what was expected lasts as long as how it went (a new round clears it).
    const asExpected = Object.entries(run.asExpected ?? {}).filter(
      ([id]) => next.outcomes[id] !== undefined,
    );
    return {
      ...next,
      ...(Object.keys(rounds).length > 0 ? { rounds } : {}),
      ...(run.changes ? { changes: run.changes } : {}),
      ...(asExpected.length > 0 ? { asExpected: Object.fromEntries(asExpected) } : {}),
      ...((next.attempts ?? run.attempts) ? { attempts: next.attempts ?? run.attempts } : {}),
    };
  }

  /**
   * Where in its queue an agent goes next, from how the tasks it has done went (`done`). Its
   * repeats' `rounds` are moved on in place.
   */
  #next(
    node: AgentNode,
    done: Readonly<Record<string, Outcome>>,
    rounds: Record<string, Round>,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun {
    const outcomes: Record<string, Outcome> = { ...done };
    const queue = node.data.queue ?? [];
    for (const [index, item] of queue.entries()) {
      // Stopped at an OK: nothing after it runs.
      if (outcomes[item.id] === 'stopped') return { current: item.id, status: 'stopped', outcomes };
      if (outcomes[item.id] !== undefined) continue;
      // Only the user moves the queue on from an OK (decide).
      if (isApproval(item)) return { current: item.id, status: 'asking', outcomes };
      const at = isRepeat(item)
        ? this.#rounds(node, item, queue.slice(0, index), outcomes, rounds, agents, now)
        : isIf(item)
          ? this.#ifThen(node, item, index, outcomes)
          : this.#reach(node.id, item, Infinity, outcomes, agents, now);
      if (typeof at !== 'string') return at;
      outcomes[item.id] = at;
    }
    return { status: 'done', outcomes };
  }

  /**
   * What happens when an agent's queue reaches an item that holds or runs: a delay, a wait, a step
   * or a message (in its queue, or in round `round` of a repeat in it; Infinity outside one). Where
   * it then is (held, stopped, or busy with the task), or, done at once, how the item went.
   */
  #reach(
    agent: string,
    item: RepeatedItem,
    round: number,
    outcomes: Record<string, Outcome>,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun | Outcome {
    const key = JSON.stringify([agent, item.id]);
    if (isDelay(item)) {
      const until = this.#until(key, agent, item.delay, now) ?? now;
      if (!this.#ended.has(key) && now < until)
        return { current: item.id, status: 'waiting', until, outcomes };
      return 'succeeded';
    }
    if (!isWait(item))
      return this.#gate(agent, item, outcomes, now) ?? this.#begin(agent, item, outcomes);
    const results = item.waitFor.map((target) => this.#resultOf(target, agents, round));
    // A stop wins over everything, a time limit too: what it waits for will never be done.
    if (results.includes('stopped')) return { current: item.id, status: 'stopped', outcomes };
    if (results.every((result) => result !== undefined))
      return results.includes('cancelled')
        ? 'cancelled'
        : results.includes('failed')
          ? 'failed'
          : 'succeeded';
    // Arrival counts for a limit added while it waits, too.
    this.#arrive(key, now);
    const until = item.timeout && this.#until(key, agent, item.timeout, now, true);
    if (this.#ended.has(key) || (until !== undefined && now >= until)) return 'timedOut';
    return {
      current: item.id,
      status: 'waiting',
      ...(until === undefined ? {} : { until }),
      outcomes,
    };
  }

  /**
   * An if-then the queue reached (at `index`): its next step to run, or how it went. Its condition
   * is decided once, of the task before it (the agent busy with it while it is asked), and is
   * skipped where it cannot hold.
   */
  #ifThen(
    node: AgentNode,
    item: QueueIf,
    index: number,
    outcomes: Record<string, Outcome>,
  ): AgentRun | Outcome {
    const queue = node.data.queue ?? [];
    const key = JSON.stringify([node.id, item.id]);
    if (unfit(queue, index) !== undefined && !this.#held.has(key)) this.#held.set(key, false);
    const held = this.#judge(node, key, item.if, lastRan(queue.slice(0, index), outcomes), {
      current: item.id,
      outcomes,
    });
    if (typeof held !== 'boolean') return held;
    if (!held) return 'skipped';
    const step = item.then.find((s) => outcomes[s.id] === undefined);
    if (step) {
      return (
        this.#gate(node.id, step, outcomes, this.#io.now()) ?? this.#begin(node.id, step, outcomes)
      );
    }
    const last = item.then.at(-1);
    return (last && outcomes[last.id]) ?? 'succeeded';
  }

  /**
   * A repeat the queue reached (`before`: the items above it): where it is in its round now, or
   * once it is over, how it went. Each round runs what it holds in order, as a queue runs; at its
   * end, the condition is decided (once) of the round's last task that ran (or the last before the
   * repeat, if none did; the agent busy with it while it is asked). If it holds, the repeat
   * succeeded; if not, the next round starts, afresh, while rounds are left (`rounds`, and those
   * the user added); then it fails and goes on, or asks the user. A repeat that follows another
   * instead goes round when that one does (#follow), and ends with it. Rounds that end at once run
   * on here, no further than the rounds left.
   */
  #rounds(
    node: AgentNode,
    repeat: QueueRepeat,
    before: readonly QueueItem[],
    outcomes: Record<string, Outcome>,
    rounds: Record<string, Round>,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun | Outcome {
    if (repeat.repeat.length === 0) return 'skipped';
    let state = rounds[repeat.id] ?? { round: 1 };
    rounds[repeat.id] = state;
    for (;;) {
      for (const item of repeat.repeat) {
        if (outcomes[item.id] !== undefined) continue;
        const at = this.#reach(node.id, item, state.round, outcomes, agents, now);
        if (typeof at !== 'string') return at;
        outcomes[item.id] = at;
      }
      const { until } = repeat;
      if (isRepeatEnds(until)) {
        const followed = this.#follow(repeat, until, state.round, outcomes, agents);
        if (followed !== undefined) return followed;
      } else {
        const key = JSON.stringify([node.id, repeat.id, state.round]);
        const held = this.#judge(
          node,
          key,
          until,
          lastRan(repeat.repeat, outcomes) ?? lastRan(before, outcomes),
          { current: repeat.id, outcomes },
        );
        if (typeof held !== 'boolean') return held;
        if (held) return 'succeeded';
        if (state.round >= repeat.rounds + (state.more ?? 0)) {
          return repeat.otherwise === 'goOn'
            ? 'failed'
            : { current: repeat.id, status: 'asking', outcomes };
        }
      }
      // The next round: what this one did is kept for waits matched to it, then forgotten; its
      // holds are counted afresh.
      for (const item of repeat.repeat) {
        const at = JSON.stringify([node.id, item.id]);
        const outcome = outcomes[item.id];
        if (outcome !== undefined)
          this.#past.set(JSON.stringify([node.id, item.id, state.round]), outcome);
        Reflect.deleteProperty(outcomes, item.id);
        this.#arrived.delete(at);
        this.#ended.delete(at);
        this.#due.delete(at);
      }
      state = { ...state, round: state.round + 1 };
      rounds[repeat.id] = state;
    }
  }

  /**
   * Where a repeat that follows another (its leader, `until`) is at the end of its round `round`:
   * undefined to go round again, once the leader has gone on to a later round; the leader's outcome
   * once it is over (succeeded if it is gone); stopped with the leader's queue; or else held until
   * the leader goes on.
   */
  #follow(
    repeat: QueueRepeat,
    until: RepeatEnds,
    round: number,
    outcomes: Record<string, Outcome>,
    agents: Readonly<Record<string, AgentRun>>,
  ): AgentRun | Outcome | undefined {
    const queue = this.#agents().find((n) => n.id === until.agent)?.data.queue;
    const leader = queue && findItem(queue, until.item)?.item;
    if (!leader || !isRepeat(leader)) return 'succeeded';
    const run = agents[until.agent];
    if ((run?.rounds?.[leader.id]?.round ?? 0) > round) return undefined;
    const ended = run?.outcomes[leader.id];
    if (ended !== undefined) return ended;
    return {
      current: repeat.id,
      status: run?.status === 'stopped' ? 'stopped' : 'waiting',
      outcomes,
    };
  }

  /** When an agent reached a hold (by agent and item): now, the first time it is asked. */
  #arrive(key: string, now: number): number {
    const arrived = this.#arrived.get(key) ?? now;
    this.#arrived.set(key, arrived);
    return arrived;
  }

  /**
   * When a hold's time comes (a delay's, or a wait's time limit: `limit`; by agent and item, `key`),
   * counted from when the agent reached it. A usage window's reset is the one its backend's reading
   * said then, kept: the next window's reset, read meanwhile, does not hold it again. A window
   * never read is no time to wait for: a delay ends at once, and the user is told so; a time limit
   * is no limit.
   */
  #until(key: string, agent: string, time: Time, now: number, limit = false): number | undefined {
    const arrived = this.#arrive(key, now);
    if (!isUsageReset(time)) return deadline(time, arrived);
    const at = JSON.stringify(time);
    const due = this.#due.get(key);
    if (due?.time === at) return due.at;
    const window = this.#readingOf(time.backend)?.windows[time.resets];
    const until =
      limit && window === undefined
        ? undefined
        : deadline(time, arrived, () => window?.resetsAt ?? undefined);
    this.#due.set(key, { time: at, at: until });
    const node = this.#agents().find((n) => n.id === agent);
    if (!limit && window === undefined && node) {
      this.#after(0, () => {
        this.#io.tell(node, unread(time.backend, time.resets, this.#catalog));
      });
    }
    return until;
  }

  /** A backend's latest usage reading (RunIO.usage), if it has one. */
  #readingOf(backend: UsageBackendId): UsageReading | undefined {
    return this.#io.usage?.().readings.find((reading) => reading.backend === backend);
  }

  /**
   * Whether the usage rule of the backend an agent spends (catalog.ts usageBackendOf: none where no
   * reading sees it) holds it before a task it would start now: its latest reading over the rule's
   * share of its window, and the user not having said to go on until that window resets. Warn me
   * tells the user (once a window, in this agent's session) and holds nothing; pause and ask me
   * asks them; wait for the reset (the rule's, or the user's answer) holds it until the window
   * resets (or asks, without a reset time to wait for).
   */
  #gate(
    agent: string,
    task: QueueStep | QueueMessage,
    outcomes: Record<string, Outcome>,
    now: number,
  ): AgentRun | undefined {
    const destination = isMessage(task) ? (task.target ?? agent) : agent;
    if (this.#run.agents[destination]?.paused)
      return { current: task.id, status: 'waiting', outcomes };
    const to = this.#agents().find((n) => n.id === destination);
    if (to && this.#catalog.connectionOf(to.data) === 'unavailable')
      return {
        current: task.id,
        status: 'asking',
        outcomes,
        refused: {
          agent: destination,
          connection: 'unavailable',
          text: 'This agent has no connection; choose Claude or Codex in Agent settings.',
        },
      };
    const rule = this.usageRule(agent, now);
    if (!rule) return undefined;
    const { hold, action } = rule;
    if (action === 'warn') {
      this.warnUsage(agent, hold, now);
      return undefined;
    }
    if (action === 'waitForReset' && hold.resetsAt !== null) {
      return { current: task.id, status: 'waiting', until: hold.resetsAt, outcomes, usage: hold };
    }
    return { current: task.id, status: 'asking', outcomes, usage: hold };
  }

  /**
   * What the usage rule of the backend an agent spends (catalog.ts usageBackendOf: none where no
   * reading sees it) calls for before it starts something now, a task or a party's message: its
   * latest reading over the rule's share of its window, and what to do (the rule's action, unless
   * the user said to go on, or to wait, until that window resets). Undefined: nothing holds it.
   */
  usageRule(
    agent: string,
    now = this.#io.now(),
  ): { hold: UsageHold; action: UsageAction } | undefined {
    const node = this.#agents().find((n) => n.id === agent);
    const backend = node && this.#catalog.usageBackendOf(node.data);
    const rule = backend && this.#io.usage?.().rules[backend];
    if (!node || !backend || !rule) return undefined;
    const window = windowNow(this.#readingOf(backend), rule.window, now);
    if (!window || window.usedPercent <= rule.percent) return undefined;
    const hold: UsageHold = {
      backend,
      window: rule.window,
      percent: rule.percent,
      used: window.usedPercent,
      resetsAt: window.resetsAt,
    };
    const decided = this.#usageDecided.get(JSON.stringify([backend, rule.window]));
    const choice = decided && now < decided.until ? decided.choice : undefined;
    if (choice === 'goOn') return undefined;
    return { hold, action: choice === 'wait' ? 'waitForReset' : rule.action };
  }

  /**
   * Warns the user in an agent's session that its backend's usage is over its rule's share (as
   * Warn me does): once a window, whatever the warning was for.
   */
  warnUsage(agent: string, hold: UsageHold, now = this.#io.now()): void {
    const node = this.#agents().find((n) => n.id === agent);
    const warned = JSON.stringify([hold.backend, hold.window, hold.resetsAt]);
    if (!node || this.#warned.has(warned)) return;
    this.#warned.add(warned);
    this.#after(0, () => {
      this.#io.tell(node, warningText(hold, this.#catalog, now, this.#io.locale));
    });
  }

  /**
   * The user's answer where a usage rule asks (asks.ts): go on, or wait for the reset (for every
   * agent on that backend, until the window resets), or stop this queue there: the whole if-then
   * or repeat the held task is in.
   */
  #answerUsage(node: AgentNode, hold: UsageHold, item: string, answer: Answer): void {
    if (!('choice' in answer)) return;
    if (answer.choice === 'goOn' || (answer.choice === 'wait' && hold.resetsAt !== null)) {
      this.#decideUsage(hold, answer.choice);
    } else if (answer.choice === 'stop') {
      const queue = node.data.queue ?? [];
      const top = queue.find(
        (q) =>
          q.id === item ||
          (isIf(q) && q.then.some((s) => s.id === item)) ||
          (isRepeat(q) && q.repeat.some((r) => r.id === item)),
      );
      this.#record(node.id, top?.id ?? item, 'stopped');
    } else {
      return;
    }
    this.#settle(true);
  }

  /** Keeps what the user decided where a usage rule held agents, until the window resets. */
  #decideUsage(hold: UsageHold, choice: 'goOn' | 'wait'): void {
    this.#usageDecided.set(JSON.stringify([hold.backend, hold.window]), {
      choice,
      until: hold.resetsAt ?? Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * How what a wait waits for went, once it is done; undefined until then; 'stopped' if it never
   * will be, its agent's queue stopped short of it. A step: its outcome. An agent's work: the
   * outcome of its last task that ran. What is gone counts as done, and well. A step in a repeat is
   * done round by round: for a wait in round `round` of a repeat, once it has run that many times
   * (or its repeat is over, as it will not run again), how it went that round; for a wait outside
   * one (`round` Infinity), once its repeat is over.
   */
  #resultOf(
    target: WaitTarget,
    agents: Readonly<Record<string, AgentRun>>,
    round: number,
  ): Outcome | undefined {
    const node = this.#agents().find((n) => n.id === target.agent);
    if (!node) return 'succeeded';
    const run = agents[target.agent];
    const stopped = run?.status === 'stopped';
    if (target.item === undefined) {
      if (stopped) return 'stopped';
      if (run?.status !== 'done') return undefined;
      const last = lastRan(node.data.queue ?? [], run.outcomes);
      return (last && run.outcomes[last.id]) ?? 'succeeded';
    }
    const found = findItem(node.data.queue ?? [], target.item);
    if (!found) return 'succeeded';
    const outcome = run?.outcomes[target.item];
    if (found.repeat) {
      const at = run?.rounds?.[found.repeat.id]?.round ?? 0;
      const times = Math.max(at - 1, 0) + (outcome === undefined ? 0 : 1);
      if (times >= round) {
        return round === at
          ? (outcome ?? 'succeeded')
          : (this.#past.get(JSON.stringify([target.agent, target.item, round])) ?? 'succeeded');
      }
      if (run?.outcomes[found.repeat.id] !== undefined) return outcome ?? 'succeeded';
      return stopped ? 'stopped' : undefined;
    }
    if (outcome === undefined || outcome === 'stopped') return stopped ? 'stopped' : undefined;
    return outcome;
  }

  /**
   * Whether a condition holds of the task `checked` (undefined: none ran) in an agent's queue,
   * decided once (by `key`). Of how that task went; whether the output contains it is read from
   * what it replied in that task's turn, and a condition in the user's words is asked of it, in its
   * session (while it is, it is busy `at` its If or repeat: an AgentRun).
   */
  #judge(
    node: AgentNode,
    key: string,
    condition: Condition,
    checked: QueueItem | undefined,
    at: { current: string; outcomes: Record<string, Outcome> },
  ): boolean | AgentRun {
    const known = this.#held.get(key);
    if (known !== undefined) return known;
    const previous = checked && at.outcomes[checked.id];
    let held: boolean;
    switch (condition.kind) {
      case 'succeeded':
        held = previous === 'succeeded';
        break;
      case 'failed':
        held = previous === 'failed';
        break;
      case 'timedOut':
        held = previous === 'timedOut';
        break;
      case 'outputContains':
        if (this.#unheard(node)) return this.#unheardCondition(node, key, at);
        held = replyContains(
          this.#replyOf(node.id, checked, at.outcomes),
          condition.text,
          condition.wholeLine,
        );
        break;
      case 'freeText':
        // Never ask when its answer cannot be heard.
        if (!this.#unheard(node)) return this.#ask(node, key, condition.text, at);
        return this.#unheardCondition(node, key, at);
      case 'usageAbove': {
        // Its backend’s latest reading.
        const window = windowNow(
          this.#readingOf(condition.backend),
          condition.window,
          this.#io.now(),
        );
        held = window !== undefined && window.usedPercent > condition.percent;
        break;
      }
    }
    this.#held.set(key, held);
    return held;
  }

  /**
   * Asks a connected agent, in its session, whether a condition in the user's words holds: it is
   * busy (at its If or repeat) until its turn ends. A clear yes/no decides (by `key`); a failed,
   * cancelled or unclear query holds for the user without inventing a condition result.
   */
  #ask(
    node: AgentNode,
    key: string,
    condition: string,
    { current, outcomes }: { current: string; outcomes: Record<string, Outcome> },
  ): AgentRun {
    const token = {};
    this.#busy.set(node.id, token);
    const attempts = this.#attempts(this.#run.agents[node.id], current);
    this.#send(node, conditionQuestion(condition), {
      holder: { agent: node.id, token },
      ended: ({ failed, reply, result }) => {
        if (this.#busy.get(node.id) !== token) return;
        this.#busy.delete(node.id);
        const cancelled = result?.status === 'cancelled';
        const failedQuery = failed || result?.status === 'failed';
        const yes = cancelled || failedQuery ? undefined : yesOrNo(reply);
        if (yes === undefined) {
          const kind = cancelled ? 'cancelled' : failedQuery ? 'failed' : 'uncertain';
          const reason =
            result?.status !== 'completed' && result
              ? result.reason
              : failed
                ? 'error'
                : 'unclear-answer';
          const text =
            result?.message ??
            (cancelled
              ? 'The condition query was cancelled. Inspect the session before deciding or retrying.'
              : failedQuery
                ? 'The agent could not judge this condition. Inspect the session before deciding or retrying.'
                : 'The answer did not clearly say yes or no. Decide whether the condition holds or ask again.');
          this.#endAttempt(node.id, current, kind, reason, text);
          const at = this.#run.agents[node.id];
          if (at)
            this.#run = {
              ...this.#run,
              agents: {
                ...this.#run.agents,
                [node.id]: {
                  ...at,
                  status: 'asking',
                  problem: { kind, reason, text, agent: node.id, conditionKey: key },
                },
              },
            };
        } else {
          this.#endAttempt(
            node.id,
            current,
            'succeeded',
            'completed',
            yes ? 'The condition holds.' : 'The condition does not hold.',
          );
          this.#held.set(key, yes);
        }
        this.#settle(true);
      },
    });
    return { current, status: 'running', outcomes, attempts };
  }

  /** An absent native reply is unknown, even when the condition itself is only a text search. */
  #unheardCondition(
    node: AgentNode,
    key: string,
    at: { current: string; outcomes: Record<string, Outcome> },
  ): AgentRun {
    return {
      ...at,
      status: 'asking',
      problem: {
        kind: 'uncertain',
        reason: 'unheard-reply',
        agent: node.id,
        conditionKey: key,
        text: 'This agent’s replies cannot be read. Inspect its session and decide whether the condition holds.',
      },
    };
  }

  /**
   * Whether corrallm can't read what a connected agent replies (RunIO.unheard): the first time a run
   * needs to, it says so in the agent's session.
   */
  #unheard(node: AgentNode): boolean {
    if (this.#io.unheard?.(node) !== true) return false;
    if (!this.#toldUnheard.has(node.id)) {
      this.#toldUnheard.add(node.id);
      this.#io.tell(node, UNHEARD);
    }
    return true;
  }

  /**
   * What an agent replied in the turn of a task it finished: a step's or a message's (a message
   * handed to another agent: what that agent replied); an if-then's or a repeat's, that of its
   * last task that ran. '' for anything else (a wait), or nothing.
   */
  #replyOf(
    agent: string,
    item: QueueItem | undefined,
    outcomes: Readonly<Record<string, Outcome>>,
  ): string {
    if (!item) return '';
    if (isIf(item)) return this.#replyOf(agent, lastRan(item.then, outcomes), outcomes);
    if (isRepeat(item)) return this.#replyOf(agent, lastRan(item.repeat, outcomes), outcomes);
    return this.#replies.get(JSON.stringify([agent, item.id])) ?? '';
  }

  /**
   * Sets the run's one alarm for the next delay or time limit to come, if it is not set for it
   * already: no later than a minute away, so the clock is looked at again at least that often.
   * When it goes off, the run settles: what is due moves on, and the alarm is set for what is next.
   */
  #arm(now: number): void {
    const next = this.#run.running
      ? Math.min(
          ...Object.values(this.#run.agents).flatMap((run) =>
            !run.paused && run.status === 'waiting' && run.until !== undefined ? [run.until] : [],
          ),
        )
      : Infinity;
    if (this.#alarm?.at === next) return;
    this.#alarm?.cancel();
    this.#alarm = undefined;
    if (next === Infinity) return;
    const cancel = this.#io.later(
      () => {
        this.#alarm = undefined;
        this.#settle(false);
      },
      Math.min(Math.max(next - now, 0), ALARM_MS),
    );
    this.#alarm = { at: next, cancel };
  }

  /**
   * Starts a task: the agent is busy with it until it finishes. A message, or a connected agent's
   * step, finishes when the turn it starts ends (a message aimed at another agent, that agent's
   * turn): a tool step as its exact last-line SUCCEEDED or FAILED verdict says. Expected failure
   * inverts a verified verdict. Native errors and cancellations hold for inspection; missing or
   * unreadable verdicts stay uncertain.
   */
  #begin(
    agent: string,
    task: QueueStep | QueueMessage,
    outcomes: Record<string, Outcome>,
    correction?: { note: string; images?: readonly MessageImage[] | undefined },
  ): AgentRun {
    const token = {};
    this.#busy.set(agent, token);
    const previous = this.#run.agents[agent];
    const attempts = this.#attempts(previous, task.id, correction?.note);
    const ended = (turn: TurnEnd) => {
      this.#taskEnded(agent, task, token, turn);
    };
    const node = this.#agents().find((n) => n.id === agent);
    const holder = { agent, token };
    if (!isMessage(task)) {
      if (node) {
        const original = this.#stepMessage(node, task);
        const text = correction
          ? corrected(
              correction.note,
              `Continue this original task and report its result:\n${original}`,
              this.#shellPrefix(node),
            )
          : original;
        this.#send(node, text, {
          ended,
          holder,
          ...(correction
            ? { origin: 'user', displayText: correction.note, images: correction.images }
            : {}),
        });
      }
    } else if (task.message.trim() === '') {
      this.#after(
        0,
        () => {
          this.#finish(agent, task.id, token, 'skipped', '');
        },
        holder,
      );
    } else {
      const to =
        task.target === undefined || task.target === agent
          ? node
          : this.#agents().find((n) => n.id === task.target);
      if (to)
        this.#send(
          to,
          correction
            ? corrected(
                correction.note,
                `Continue the original task: ${task.message}`,
                this.#shellPrefix(to),
              )
            : task.message,
          {
            ended,
            holder,
            ...(correction
              ? { origin: 'user', displayText: correction.note, images: correction.images }
              : {}),
          },
        );
      else
        this.#after(
          0,
          () => {
            this.#finish(agent, task.id, token, 'succeeded', '');
          },
          holder,
        );
    }
    return {
      current: task.id,
      status: 'running',
      outcomes,
      attempts,
      ...(previous?.paused ? { paused: true } : {}),
    };
  }

  /** Native execution failures take precedence over a declared task verdict. */
  #taskEnded(agent: string, task: QueueStep | QueueMessage, token: object, turn: TurnEnd): void {
    if (this.#busy.get(agent) !== token) return;
    const destination = isMessage(task) ? (task.target ?? agent) : agent;
    const result = turn.result;
    let problem: TaskProblem | undefined;
    let outcome: Outcome = 'succeeded';
    let asExpected: boolean | undefined;
    if (result?.status === 'cancelled') {
      outcome = 'cancelled';
      problem = {
        kind: 'cancelled',
        reason: result.reason,
        text: result.message ?? 'This task was interrupted or taken back.',
        agent: destination,
      };
    } else if (turn.failed || result?.status === 'failed') {
      outcome = 'failed';
      problem = {
        kind: 'failed',
        reason: result?.reason ?? 'error',
        text: result?.message ?? 'The agent could not finish this turn.',
        agent: destination,
      };
    } else if (!isMessage(task)) {
      const verdict = isCommand(task.action) ? true : stepVerdict(turn.reply);
      const node = this.#agents().find((n) => n.id === agent);
      const unheard = node ? this.#unheard(node) : false;
      if (verdict === undefined || unheard) {
        problem = {
          kind: 'uncertain',
          reason: 'missing-verdict',
          text: 'The turn ended without a clear SUCCEEDED or FAILED verdict. Inspect the session before continuing.',
          agent: destination,
        };
      } else {
        const expectedFailure = task.expect === 'fails';
        outcome = verdict === expectedFailure ? 'failed' : 'succeeded';
        asExpected = expectedFailure ? !verdict : undefined;
        if (outcome === 'failed')
          problem = {
            kind: 'failed',
            reason: 'task-failed',
            text: expectedFailure
              ? 'This step succeeded, but it was expected to fail.'
              : 'The agent reported that this step failed.',
            agent: destination,
          };
      }
    }
    this.#finish(agent, task.id, token, outcome, turn.reply, asExpected, problem);
  }

  /**
   * What a connected agent's step asks of it (turns.ts): its action, as its adapter names it, the
   * agent it acts on if that is another one still there, and what it is to do, in the user's words.
   */
  #stepMessage(node: AgentNode, step: QueueStep): string {
    const actions = this.#catalog.actionsOf(node.data);
    const other =
      step.target !== undefined && step.target !== node.id
        ? this.#agents().find((n) => n.id === step.target)
        : undefined;
    return stepMessage(
      step.action,
      actions,
      other && agentName(this.#nodes, other.id),
      step.instruction,
    );
  }

  /**
   * Sends a message to an agent's session for the run (RunIO.send); `ended` hears how its turn
   * ended. Until then, Stop (#cancel) takes it back. If that session would not start, the agent
   * busy with the task it is for (`holder`, while its token is) asks the user (#refused).
   */
  #send(
    to: AgentNode,
    text: string,
    {
      ended,
      images,
      holder,
      origin,
      displayText,
    }: {
      ended?: (turn: TurnEnd) => void;
      images?: readonly MessageImage[] | undefined;
      holder?: { agent: string; token: object };
      origin?: 'user';
      displayText?: string;
    } = {},
  ): void {
    // Its turn may end at once (a session that cannot start): then there is nothing to take back.
    const sent = { over: false };
    let ready = this.#io.beforeSend === undefined;
    let started = false;
    const dispatch = () => {
      if (sent.over || !ready || started) return;
      if (
        origin !== 'user' &&
        (this.#run.agents[to.id]?.paused || (holder && this.#run.agents[holder.agent]?.paused))
      )
        return;
      if (!this.#run.running && this.#run.paused) return;
      started = true;
      // What the user typed may be a shell command for its CLI's bash mode; what the run sends of
      // its own (a canvas's messages, which a shared file may hold) never is: checked as it goes,
      // against the connection its recipient runs now.
      const now = this.#agents().find((n) => n.id === to.id) ?? to;
      const prefix = this.#shellPrefix(now);
      if (origin !== 'user' && startsWith(text, prefix)) {
        const name = this.#catalog.connectionName(this.#catalog.connectionOf(now.data)) ?? '';
        this.#after(0, () => {
          if (sent.over) return;
          sent.over = true;
          this.#sent.delete(sent);
          ended?.({
            failed: true,
            reply: '',
            result: { status: 'failed', reason: 'declined', message: shellRefused(prefix, name) },
          });
        });
        return;
      }
      const withdraw = this.#io.send(
        to,
        text,
        (turn) => {
          if (sent.over) return;
          sent.over = true;
          this.#sent.delete(sent);
          ended?.(turn);
        },
        images,
        holder &&
          ((refusal) => {
            this.#refused(holder, to, refusal);
          }),
        origin,
        displayText,
      );
      pending.withdraw = () => {
        if (sent.over) return;
        sent.over = true;
        withdraw();
      };
    };
    const pending: PendingSend = {
      owner: holder?.agent ?? to.id,
      destination: to.id,
      dispatch,
      withdraw: () => {
        sent.over = true;
      },
    };
    this.#sent.set(sent, pending);
    if (this.#io.beforeSend) {
      void Promise.resolve()
        .then(() => this.#io.beforeSend?.())
        .then(
          () => {
            ready = true;
            dispatch();
          },
          (error: unknown) => {
            if (sent.over) return;
            sent.over = true;
            this.#sent.delete(sent);
            ended?.({
              failed: true,
              reply: '',
              result: {
                status: 'failed',
                reason: 'error',
                message: `The run could not be saved, so the prompt was not sent: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
          },
        );
    } else dispatch();
  }

  /** The text an agent's connection runs as a shell command, if any (catalog.ts shellPrefix). */
  #shellPrefix(agent: AgentNode): string | undefined {
    return this.#catalog.shellPrefix(this.#catalog.connectionOf(agent.data));
  }

  /**
   * The session a task's message went to would not start: the agent busy with that task (if it
   * still is) asks the user, saying why, until that session's agent runs another way.
   */
  #refused(
    { agent, token }: { agent: string; token: object },
    to: AgentNode,
    { text, switchTo }: Refusal,
  ): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || this.#busy.get(agent) !== token || !at) return;
    const refused = {
      agent: to.id,
      connection: this.#catalog.connectionOf(to.data),
      text,
      ...(switchTo === undefined ? {} : { switchTo }),
    };
    this.#set({
      ...this.#run,
      agents: { ...this.#run.agents, [agent]: { ...at, status: 'asking', refused } },
    });
  }

  /**
   * Agents held because a session would not start work again once its agent runs another way
   * (or is gone): its session sends what it kept, or the unsent task can begin. Whether any did.
   */
  #unrefuse(): boolean {
    let changed = false;
    const agents = { ...this.#run.agents };
    for (const [id, at] of Object.entries(agents)) {
      const { refused } = at;
      if (!refused) continue;
      const to = this.#agents().find((n) => n.id === refused.agent);
      if (to && this.#catalog.connectionOf(to.data) === refused.connection) continue;
      const running: AgentRun = { ...at, status: 'running' };
      delete running.refused;
      agents[id] = running;
      changed = true;
    }
    if (changed) this.#run = { ...this.#run, agents };
    return changed;
  }

  /**
   * Answers a repeat out of rounds: one more round (`more`), first sending the agent what to try
   * next (`reply`, with the images pasted into it; not waited for: its session runs it before the
   * round's first message); or go on (`goOn`), the repeat failed.
   */
  #decideRounds(node: AgentNode, at: AgentRun, repeat: QueueRepeat, answer: Answer): void {
    if ('reply' in answer) {
      const note = answer.reply.trim();
      const images = answer.images ?? [];
      if (note === '' && images.length === 0) return;
      this.#send(node, note, { images: images.length === 0 ? undefined : images, origin: 'user' });
    } else if (answer.choice === 'goOn') {
      this.#record(node.id, repeat.id, 'failed');
      this.#settle(true);
      return;
    } else if (answer.choice !== 'more') {
      return;
    }
    const state = at.rounds?.[repeat.id] ?? { round: 1 };
    const rounds = { ...at.rounds, [repeat.id]: { ...state, more: (state.more ?? 0) + 1 } };
    this.#run = { ...this.#run, agents: { ...this.#run.agents, [node.id]: { ...at, rounds } } };
    this.#settle(true);
  }

  /**
   * Sends the changes the user asked for at an OK (`note`, and the images pasted into it) to the
   * queue's own agent, as a turn of its session: it works on them at the OK, and once the turn
   * ends (however it ends) the OK asks again.
   */
  #askForChanges(
    node: AgentNode,
    at: AgentRun,
    ok: string,
    note: string,
    images: readonly MessageImage[],
  ): void {
    if (note === '' && images.length === 0) return;
    const token = {};
    this.#busy.set(node.id, token);
    const asked = [note, imagesText(images)].filter((part) => part !== '').join(' ');
    const changes = { ...at.changes, [ok]: [...(at.changes?.[ok] ?? []), asked] };
    const run: AgentRun = { ...at, status: 'running', changes };
    this.#set({ ...this.#run, agents: { ...this.#run.agents, [node.id]: run } });
    this.#send(node, note, {
      origin: 'user',
      holder: { agent: node.id, token },
      ended: () => {
        if (this.#busy.get(node.id) !== token) return;
        this.#busy.delete(node.id);
        this.#settle(true);
      },
      images: images.length === 0 ? undefined : images,
    });
  }

  #finish(
    agent: string,
    task: string,
    token: object,
    outcome: Outcome,
    reply: string,
    asExpected?: boolean,
    problem?: TaskProblem,
  ): void {
    if (this.#busy.get(agent) !== token) return;
    this.#busy.delete(agent);
    this.#replies.set(JSON.stringify([agent, task]), reply);
    this.#endAttempt(
      agent,
      task,
      problem?.kind ??
        (outcome === 'succeeded' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed'),
      problem?.reason,
      problem?.text,
    );
    // Only a task's own failure is one its queue was written for (an If it failed, a repeat's next
    // round): a native one (a usage limit, a login) holds for the user, as cancelling does.
    if (problem && (problem.reason !== 'task-failed' || !this.#handlesFailure(agent, task))) {
      const at = this.#run.agents[agent];
      if (at)
        this.#run = {
          ...this.#run,
          agents: {
            ...this.#run.agents,
            [agent]: {
              ...at,
              current: task,
              status: 'asking',
              problem,
              ...(asExpected === undefined
                ? {}
                : { asExpected: { ...at.asExpected, [task]: asExpected } }),
            },
          },
        };
      this.#settle(true);
      return;
    }
    this.#record(agent, task, outcome, asExpected);
    this.#settle(true);
  }

  /**
   * Records how an agent's task went, for the next settle to move it on from; and, for a step
   * expected to fail, how that went against what was expected.
   */
  #record(agent: string, task: string, outcome: Outcome, asExpected?: boolean): void {
    const run = this.#run.agents[agent];
    if (!run) return;
    const next: AgentRun = { ...run, outcomes: { ...run.outcomes, [task]: outcome } };
    if (asExpected !== undefined) next.asExpected = { ...run.asExpected, [task]: asExpected };
    this.#run = { ...this.#run, agents: { ...this.#run.agents, [agent]: next } };
  }

  #after(ms: number, run: () => void, holder?: { agent: string; token: object }): void {
    const cancel = this.#io.later(() => {
      this.#timers.delete(cancel);
      run();
    }, ms);
    this.#timers.set(cancel, holder);
  }

  /**
   * Cancels what the run has going: its timers, and what it sent to sessions, taken back (off
   * their queues, or their turns interrupted). No agent is busy any more, so how those turns end
   * is not heard.
   */
  #cancel(): void {
    this.#observed.clear();
    for (const cancel of this.#timers.keys()) cancel();
    this.#timers.clear();
    this.#busy.clear();
    this.#alarm?.cancel();
    this.#alarm = undefined;
    const sent = [...this.#sent.values()];
    this.#sent.clear();
    for (const pending of sent) pending.withdraw();
  }

  /**
   * Forgets what the last run decided (its if-thens, its repeats' rounds) and when it reached its
   * holds, to run from the top.
   */
  #forget(): void {
    this.#observed.clear();
    this.#held.clear();
    this.#replies.clear();
    this.#arrived.clear();
    this.#ended.clear();
    this.#past.clear();
    this.#due.clear();
    this.#usageDecided.clear();
    this.#warned.clear();
    this.#toldUnheard.clear();
  }

  #set(run: Run): void {
    this.#run = run;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Where a run is with a task of an agent's (by id; null: the end of its queue), as views mark it:
 * running it, held at it (by the run, or for the user), stopped at it (or held there when the run
 * was stopped), how it went, or the end reached.
 */
export function taskState(run: Run, agent: string, item: string | null): string | undefined {
  const at = run.agents[agent];
  if (!at) return undefined;
  if (item === null) return at.status === 'done' ? 'reached' : undefined;
  if (at.current === item && at.status !== 'done') return run.running ? at.status : 'stopped';
  return at.outcomes[item];
}

/**
 * Whether a run holds anything to resume: an agent it reached, or a pause set on an agent or a
 * group. A run that has done nothing has nothing to pause: Resume would only start it.
 */
/** Each cause once: one party's second pause of the same target is the same cause. */
function distinct(causes: readonly PauseCause[]): PauseCause[] {
  return causes.filter(
    (cause, i) => causes.findIndex(({ id, by }) => id === cause.id && by === cause.by) === i,
  );
}

/** Whether `by`'s release of `id` releases `cause`: its own, or, for you, any party's. */
function releases(cause: PauseCause, id: string, by: PartyId): boolean {
  return cause.id === id && (by === 'you' || cause.by === by);
}

function resumable(agents: Readonly<Record<string, AgentRun>>, causes: PauseCauses): boolean {
  return Object.keys(agents).length > 0 || causes.individual.length > 0 || causes.groups.length > 0;
}

/** The judgment a structural item was making when its native query was interrupted. */
function conditionKey(
  agent: string,
  item: QueueItem | undefined,
  rounds?: Readonly<Record<string, Round>>,
): string | undefined {
  if (!item) return undefined;
  const condition = isIf(item)
    ? item.if
    : isRepeat(item) && !isRepeatEnds(item.until)
      ? item.until
      : undefined;
  if (!condition || (condition.kind !== 'freeText' && condition.kind !== 'outputContains'))
    return undefined;
  return JSON.stringify(
    isRepeat(item) ? [agent, item.id, rounds?.[item.id]?.round ?? 1] : [agent, item.id],
  );
}

/**
 * The last of `items` that ran: what an if-then checks, what a repeat's condition is decided of
 * at the end of a round, and, by how it went, how a wait for all of an agent's work went. Items
 * not done yet, skipped ones, and pauses (delays and OKs, which only hold the queue: queue.ts
 * isPause) are passed over.
 */
function lastRan(
  items: readonly QueueItem[],
  outcomes: Readonly<Record<string, Outcome>>,
): QueueItem | undefined {
  return items.findLast((item) => {
    const outcome = outcomes[item.id];
    return outcome !== undefined && outcome !== 'skipped' && !isPause(item);
  });
}

/** Images sent with changes asked for, as the run records them: "[Image]", "[2 images]". */
function imagesText(images: readonly MessageImage[]): string {
  if (images.length === 0) return '';
  return images.length === 1 ? '[Image]' : `[${String(images.length)} images]`;
}
