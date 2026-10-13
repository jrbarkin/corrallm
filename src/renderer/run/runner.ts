import type { Connection, MessageImage } from '../../shared/session';
import { WINDOW_NAMES, windowNow } from '../../shared/usage';
import type { UsageBackend, UsageReading, UsageState } from '../../shared/usage';
import { AGENT_ACTIONS, connectionOf, DEFAULT_AGENT } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import { agentName } from '../graph/labels';
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
} from '../graph/queue';
import type {
  Condition,
  QueueIf,
  QueueItem,
  QueueMessage,
  QueueRepeat,
  QueueStep,
  RepeatEnds,
  RepeatedItem,
  Time,
  WaitTarget,
} from '../graph/queue';
import { deadline } from '../graph/time';
import { usageBackendOf, warningText } from '../usage/usage';
import type { UsageHold } from '../usage/usage';
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
export type Outcome = 'succeeded' | 'failed' | 'skipped' | 'timedOut' | 'stopped';

/** Where a repeat is: the round it is on (or ended on), and how many rounds the user added. */
export interface Round {
  round: number;
  /** The rounds added by One more round, this run. */
  more?: number;
}

/** Where an agent's queue is, in a run. */
export interface AgentRun {
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
   * While it asks because the session its task went to would not start (an Agent SDK agent on a
   * Claude subscription): that session's agent (this one, or the one a message was handed to),
   * how it ran then, why it would not start, and the connection to switch it to. The message waits
   * in that session's queue, sent once the agent runs another way; then this one works again.
   */
  refused?: { agent: string; connection: AgentConnection; text: string; switchTo: Connection };
  /** While held at a delay, or at a wait with a time limit: when that time comes (epoch ms). */
  until?: number;
  /**
   * How each task it has finished went, by id. A repeat's items: how they went in its round now
   * (a new round clears them).
   */
  outcomes: Readonly<Record<string, Outcome>>;
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

export interface Run {
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
  switchTo: Connection;
}

/**
 * How a turn the run started in an agent's session ended: whether it failed (or was interrupted,
 * or taken off the session's queue), and what the agent replied in it (its text, '' if none).
 */
export interface TurnEnd {
  failed: boolean;
  reply: string;
}

/** What a run needs from its surroundings. */
export interface RunIO {
  /**
   * Sends a message (with images, if any) to an agent's session; `done` once the turn it starts
   * ends. `refused`, later, each time the session would not start while the message waits to go
   * (kept in its queue, sent once the agent runs another way). Returns a function that takes it
   * back: off the session's queue while it waits there, or interrupting its turn while that goes
   * on.
   */
  send: (
    agent: GraphNode,
    text: string,
    done: (turn: TurnEnd) => void,
    images?: readonly MessageImage[],
    refused?: (refusal: Refusal) => void,
  ) => () => void;
  /** Tells the user something about the run, in an agent's session (a notice there). */
  tell: (agent: GraphNode, text: string) => void;
  /** Runs an agent another way: the connection the user chose for it, as its session would not start. */
  connect: (agent: GraphNode, connection: Connection) => void;
  /** Runs `run` in `ms`; returns a function that cancels it. */
  later: (run: () => void, ms: number) => () => void;
  /** The time now (epoch ms): the only clock a run reads, for its delays and time limits. */
  now: () => number;
  /**
   * A random number from 0 up to 1, for a simulated agent: whether a step fails, or whether a
   * condition holds that only a real agent could judge. Never taken for a connected agent.
   */
  chance: () => number;
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
  unheard?: (agent: GraphNode) => boolean;
}

/** How long a simulated agent's step takes, at least and at most. */
const STEP_MS = [1500, 3500] as const;
/**
 * The longest the run sleeps before it looks at the clock again while a delay or a time limit
 * holds an agent: a timer can fire late (a sleeping laptop) and the clock can be changed.
 */
const ALARM_MS = 60_000;
/**
 * How likely a simulated agent's step is to fail, and a condition only a real agent could judge
 * (its output, or the user's own words) to hold.
 */
const FAILS = 0.25;
const HOLDS = 0.5;

/** What the run says when it waits for a usage window's reset that has never been read. */
const unread = (backend: UsageBackend, window: keyof typeof WINDOW_NAMES) =>
  `${backend}’s usage hasn’t been read yet, so the queue went on without waiting for its ${WINDOW_NAMES[window]} reset.`;

/** What the run says when it takes a connected agent's answer to its question as no. */
const UNCLEAR = 'corrallm took that as no: the answer wasn’t a clear yes or no.';
const UNANSWERED = 'corrallm took that as no: the question wasn’t answered.';
/** What the run says when a connected agent's step reply gives no verdict (turns.ts). */
const NO_VERDICT =
  'corrallm took the step as succeeded: its reply didn’t end with SUCCEEDED or FAILED.';
/** What the run says, once a run, when it can't read a connected agent's replies (RunIO.unheard). */
const UNHEARD =
  'corrallm can’t read this agent’s replies (its hooks are off), so in this run “the output ' +
  'contains” and conditions in your words don’t hold, without asking it, and its steps count as ' +
  'succeeded.';

const IDLE: Run = { running: false, agents: {} };

/**
 * Runs every agent's queue: each agent works through its queue in order. A message goes to the
 * agent's session (sessions.ts), or, aimed at another agent, to that agent's, and is done when the
 * turn it starts ends (failed, if that turn failed or was interrupted). A connected agent's step
 * goes to its session too (turns.ts words it: a slash command as it is, a tool as an instruction
 * to use it that asks how it went), done when its turn ends, failed if the agent says so (a turn
 * that ends well may run tests that fail); a simulated agent's step takes a few seconds and may
 * fail.
 * A wait holds until what it waits for is done (a step, or all of an agent's work), or its time
 * limit passes; a delay holds until its time has come; an if-then runs its steps only if its
 * condition holds of the task before it. A connected agent's conditions are its own: whether the
 * output contains something is read from what it replied in that task's turn, and a condition in
 * the user's words is asked of it, in its session, yes or no; a simulated agent's are by chance.
 * Delays and time limits are the run's own, on the real clock (`now`): no agent is asked to wait.
 * An OK holds until the user decides (`decide`): the queue goes on, the agent makes the changes
 * asked for and it asks again, or the queue stops there, and with it whatever waits on it. A
 * repeat runs what it holds in rounds, until its condition holds of a round's last task that ran,
 * at most its rounds; then it goes on having failed, or asks the user for one more round. A wait
 * in a repeat for a step in another repeat waits for it in the same round; a wait outside one, for
 * that repeat to end. A repeat that follows another goes round with it, and ends with it. Rounds,
 * like delays, are the run's: the agent is only sent each round's messages. Queues are read as
 * they run (`update` gives it the graph as it changes), so edits take effect at once. Stop takes
 * back what the run sent that is still going (RunIO.send). A task whose session would not start
 * (an Agent SDK agent on a Claude subscription) neither fails nor goes on: its agent asks the user
 * to switch that agent to another connection (`decide`), and works again once it runs another way,
 * its session sending what it kept.
 */
export class RunStore {
  #run: Run = IDLE;
  #nodes: readonly GraphNode[] = [];
  readonly #io: RunIO;
  readonly #listeners = new Set<() => void>();
  /** What cancels each timer set. */
  readonly #timers = new Set<() => void>();
  /** The task each busy agent is doing, by a token that is this run's alone. */
  readonly #busy = new Map<string, object>();
  /** What takes back each message the run sent whose turn has not ended yet. */
  readonly #sent = new Map<object, () => void>();
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

  constructor(io: RunIO) {
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

  /** Runs every queue from the top. */
  start(): void {
    this.#cancel();
    this.#forget();
    this.#run = { running: true, agents: {} };
    this.#settle(true);
  }

  /**
   * Stops where the queues are: no task goes on, and none starts. What the run sent to sessions
   * is taken back (off their queues, or their turns interrupted).
   */
  stop(): void {
    this.#cancel();
    this.#set({ ...this.#run, running: false });
  }

  /** Forgets the run, as for another canvas. */
  reset(): void {
    this.#cancel();
    this.#forget();
    this.#set(IDLE);
  }

  /**
   * Ends now the hold an agent is at (Go on now): a delay, as if its time had come; a wait, as if
   * its time limit had passed. Only while the run holds that agent at that item (`item`), so a
   * click meant for one hold never ends the next.
   */
  goOn(agent: string, item: string): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || at?.status !== 'waiting' || at.current !== item) return;
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
    if (!this.#run.running || at?.status !== 'asking' || at.current !== item) return;
    if (at.refused) {
      const { refused } = at;
      const to = this.#agents().find((n) => n.id === refused.agent);
      if (to && 'choice' in answer && answer.choice === 'switch') {
        this.#io.connect(to, refused.switchTo);
      }
      return;
    }
    const node = this.#agents().find((n) => n.id === agent);
    const held = node && findItem(node.data.queue ?? [], item)?.item;
    if (!node || !held) return;
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
   * The graph as it is now: a run goes on with new work, and past waits for what is gone; an
   * agent whose session would not start, once it runs another way.
   */
  update(nodes: readonly GraphNode[]): void {
    this.#nodes = nodes;
    if (this.#run.running) this.#settle(this.#unrefuse());
  }

  /**
   * Main told a new usage reading or rule (RunIO.usage): the rules are checked again for every
   * agent between tasks, and holds they no longer call for end.
   */
  usageChanged(): void {
    if (this.#run.running) this.#settle(false);
  }

  #agents(): GraphNode[] {
    return this.#nodes.filter((n) => n.type === 'agent');
  }

  /** Moves every agent not busy with a task on as far as it can go, until none can. */
  #settle(changed: boolean): void {
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
    if (moved || running !== this.#run.running) this.#set({ running, agents });
    this.#arm(now);
  }

  /**
   * Where an agent not busy with a task goes next: its next task, a hold (a wait, a delay, an OK, a
   * repeat out of rounds), a stop, or done. Its repeats' rounds, and what the user asked for at its
   * OKs, go with it.
   */
  #advance(
    node: GraphNode,
    run: AgentRun,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun {
    const rounds: Record<string, Round> = { ...run.rounds };
    const next = this.#next(node, run.outcomes, rounds, agents, now);
    return {
      ...next,
      ...(Object.keys(rounds).length > 0 ? { rounds } : {}),
      ...(run.changes ? { changes: run.changes } : {}),
    };
  }

  /**
   * Where in its queue an agent goes next, from how the tasks it has done went (`done`). Its
   * repeats' `rounds` are moved on in place.
   */
  #next(
    node: GraphNode,
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
      // Only the user moves the queue on from an OK (decide): no time, and no chance.
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
      return results.includes('failed') ? 'failed' : 'succeeded';
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
    node: GraphNode,
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
    node: GraphNode,
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
        this.#io.tell(node, unread(time.backend, time.resets));
      });
    }
    return until;
  }

  /** A backend's latest usage reading (RunIO.usage), if it has one. */
  #readingOf(backend: UsageBackend): UsageReading | undefined {
    return this.#io.usage?.().readings.find((reading) => reading.backend === backend);
  }

  /**
   * Whether the usage rule of the backend an agent spends (usage/usage.ts usageBackendOf: not an
   * Agent SDK agent's) holds it before a task it would start now: its latest reading over the rule's
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
    const node = this.#agents().find((n) => n.id === agent);
    const backend = node && usageBackendOf(node.data);
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
    const action = choice === 'wait' ? 'waitForReset' : rule.action;
    if (action === 'warn') {
      const warned = JSON.stringify([backend, rule.window, window.resetsAt]);
      if (!this.#warned.has(warned)) {
        this.#warned.add(warned);
        this.#after(0, () => {
          this.#io.tell(node, warningText(hold, now));
        });
      }
      return undefined;
    }
    if (action === 'waitForReset' && hold.resetsAt !== null) {
      return { current: task.id, status: 'waiting', until: hold.resetsAt, outcomes, usage: hold };
    }
    return { current: task.id, status: 'asking', outcomes, usage: hold };
  }

  /**
   * The user's answer where a usage rule asks (asks.ts): go on, or wait for the reset (for every
   * agent on that backend, until the window resets), or stop this queue there: the whole if-then
   * or repeat the held task is in.
   */
  #answerUsage(node: GraphNode, hold: UsageHold, item: string, answer: Answer): void {
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
      until: hold.resetsAt ?? Infinity,
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
   * decided once (by `key`). Of how that task went; or, for a simulated agent, by chance where only
   * a real one could judge; or, for a connected one, whether the output contains it is read from
   * what it replied in that task's turn, and a condition in the user's words is asked of it, in its
   * session (while it is, it is busy `at` its If or repeat: an AgentRun).
   */
  #judge(
    node: GraphNode,
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
        held = isConnected(node)
          ? !this.#unheard(node) &&
            replyContains(this.#replyOf(node.id, checked, at.outcomes), condition.text)
          : this.#io.chance() < HOLDS;
        break;
      case 'freeText':
        if (isConnected(node)) {
          // Never asked when its answer can't be heard.
          if (!this.#unheard(node)) return this.#ask(node, key, condition.text, at);
          held = false;
          break;
        }
        held = this.#io.chance() < HOLDS;
        break;
      case 'usageAbove': {
        // Its backend's latest reading, simulated agent or not: no chance about it.
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
   * busy (at its If or repeat) until its turn ends. Its answer decides (by `key`): yes, it holds;
   * no, or no clear answer (which it says), it does not.
   */
  #ask(
    node: GraphNode,
    key: string,
    condition: string,
    { current, outcomes }: { current: string; outcomes: Record<string, Outcome> },
  ): AgentRun {
    const token = {};
    this.#busy.set(node.id, token);
    this.#send(node, conditionQuestion(condition), {
      holder: { agent: node.id, token },
      ended: ({ failed, reply }) => {
        if (this.#busy.get(node.id) !== token) return;
        this.#busy.delete(node.id);
        const yes = failed ? undefined : yesOrNo(reply);
        if (yes === undefined) this.#io.tell(node, failed ? UNANSWERED : UNCLEAR);
        this.#held.set(key, yes ?? false);
        this.#settle(true);
      },
    });
    return { current, status: 'running', outcomes };
  }

  /**
   * Whether corrallm can't read what a connected agent replies (RunIO.unheard): the first time a run
   * needs to, it says so in the agent's session.
   */
  #unheard(node: GraphNode): boolean {
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
            run.status === 'waiting' && run.until !== undefined ? [run.until] : [],
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
   * turn): a connected agent's tool step as it says at the end of its reply (SUCCEEDED or FAILED;
   * neither, as its turn ended, which the run says); a simulated agent's step, after a while.
   */
  #begin(
    agent: string,
    task: QueueStep | QueueMessage,
    outcomes: Record<string, Outcome>,
  ): AgentRun {
    const token = {};
    this.#busy.set(agent, token);
    const finish = (outcome: Outcome, reply = '') => {
      this.#finish(agent, task.id, token, outcome, reply);
    };
    const ended = ({ failed, reply }: TurnEnd) => {
      finish(failed ? 'failed' : 'succeeded', reply);
    };
    const node = this.#agents().find((n) => n.id === agent);
    const holder = { agent, token };
    if (!isMessage(task)) {
      if (node && isConnected(node)) {
        // A tool's step went as the agent says on its reply's last line (a slash command's, as
        // its turn ended): a turn that ends well may have run tests that fail.
        const judged = ({ failed, reply }: TurnEnd) => {
          if (failed || this.#busy.get(agent) !== token) {
            ended({ failed, reply });
            return;
          }
          const verdict = stepVerdict(reply);
          if (verdict === undefined && !this.#unheard(node)) this.#io.tell(node, NO_VERDICT);
          finish(verdict === false ? 'failed' : 'succeeded', reply);
        };
        this.#send(node, this.#stepMessage(node, task), {
          ended: isCommand(task.action) ? ended : judged,
          holder,
        });
      } else {
        const [least, most] = STEP_MS;
        const ms = least + (hash(task.id) % (most - least));
        this.#after(ms, () => {
          finish(this.#io.chance() < FAILS ? 'failed' : 'succeeded');
        });
      }
    } else if (task.message.trim() === '') {
      this.#after(0, () => {
        finish('skipped');
      });
    } else {
      const own = task.target === undefined || task.target === agent;
      const to = own ? node : this.#agents().find((n) => n.id === task.target);
      if (to) this.#send(to, task.message, { ended, holder });
      // Handed to an agent that is gone: nothing to wait for.
      else
        this.#after(0, () => {
          finish('succeeded');
        });
    }
    return { current: task.id, status: 'running', outcomes };
  }

  /**
   * What a connected agent's step asks of it (turns.ts): its action, as its type names it, the
   * agent it acts on if that is another one still there, and what it is to do, in the user's words.
   */
  #stepMessage(node: GraphNode, step: QueueStep): string {
    const actions = AGENT_ACTIONS[node.data.agent ?? DEFAULT_AGENT];
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
    to: GraphNode,
    text: string,
    {
      ended,
      images,
      holder,
    }: {
      ended?: (turn: TurnEnd) => void;
      images?: readonly MessageImage[] | undefined;
      holder?: { agent: string; token: object };
    } = {},
  ): void {
    // Its turn may end at once (a session that cannot start): then there is nothing to take back.
    const sent = { over: false };
    const withdraw = this.#io.send(
      to,
      text,
      (turn) => {
        sent.over = true;
        this.#sent.delete(sent);
        ended?.(turn);
      },
      images,
      holder &&
        ((refusal) => {
          this.#refused(holder, to, refusal);
        }),
    );
    if (!sent.over) this.#sent.set(sent, withdraw);
  }

  /**
   * The session a task's message went to would not start: the agent busy with that task (if it
   * still is) asks the user, saying why, until that session's agent runs another way.
   */
  #refused(
    { agent, token }: { agent: string; token: object },
    to: GraphNode,
    { text, switchTo }: Refusal,
  ): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || this.#busy.get(agent) !== token || !at) return;
    const refused = { agent: to.id, connection: connectionOf(to.data), text, switchTo };
    this.#set({
      ...this.#run,
      agents: { ...this.#run.agents, [agent]: { ...at, status: 'asking', refused } },
    });
  }

  /**
   * Agents held because a session would not start work again once its agent runs another way
   * (or is gone): its session sends what it kept. Whether any did.
   */
  #unrefuse(): boolean {
    let changed = false;
    const agents = { ...this.#run.agents };
    for (const [id, at] of Object.entries(agents)) {
      const { refused } = at;
      if (!refused) continue;
      const to = this.#agents().find((n) => n.id === refused.agent);
      if (to && connectionOf(to.data) === refused.connection) continue;
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
  #decideRounds(node: GraphNode, at: AgentRun, repeat: QueueRepeat, answer: Answer): void {
    if ('reply' in answer) {
      const note = answer.reply.trim();
      const images = answer.images ?? [];
      if (note === '' && images.length === 0) return;
      this.#send(node, note, { images: images.length === 0 ? undefined : images });
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
    node: GraphNode,
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
      holder: { agent: node.id, token },
      ended: () => {
        if (this.#busy.get(node.id) !== token) return;
        this.#busy.delete(node.id);
        this.#settle(true);
      },
      images: images.length === 0 ? undefined : images,
    });
  }

  #finish(agent: string, task: string, token: object, outcome: Outcome, reply: string): void {
    if (this.#busy.get(agent) !== token) return;
    this.#busy.delete(agent);
    this.#replies.set(JSON.stringify([agent, task]), reply);
    this.#record(agent, task, outcome);
    this.#settle(true);
  }

  /** Records how an agent's task went, for the next settle to move it on from. */
  #record(agent: string, task: string, outcome: Outcome): void {
    const run = this.#run.agents[agent];
    if (!run) return;
    const outcomes = { ...run.outcomes, [task]: outcome };
    this.#run = { ...this.#run, agents: { ...this.#run.agents, [agent]: { ...run, outcomes } } };
  }

  #after(ms: number, run: () => void): void {
    const cancel = this.#io.later(() => {
      this.#timers.delete(cancel);
      run();
    }, ms);
    this.#timers.add(cancel);
  }

  /**
   * Cancels what the run has going: its timers, and what it sent to sessions, taken back (off
   * their queues, or their turns interrupted). No agent is busy any more, so how those turns end
   * is not heard.
   */
  #cancel(): void {
    for (const cancel of this.#timers) cancel();
    this.#timers.clear();
    this.#busy.clear();
    this.#alarm?.cancel();
    this.#alarm = undefined;
    const sent = [...this.#sent.values()];
    this.#sent.clear();
    for (const withdraw of sent) withdraw();
  }

  /**
   * Forgets what the last run decided (its if-thens, its repeats' rounds) and when it reached its
   * holds, to run from the top.
   */
  #forget(): void {
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

/** Whether an agent runs the real CLI (connected), rather than a simulated session. */
function isConnected(node: GraphNode): boolean {
  return connectionOf(node.data) !== 'simulated';
}

/** Images sent with changes asked for, as the run records them: "[Image]", "[2 images]". */
function imagesText(images: readonly MessageImage[]): string {
  if (images.length === 0) return '';
  return images.length === 1 ? '[Image]' : `[${String(images.length)} images]`;
}

/** A number from a string, the same each time: steps take their own, steady time. */
function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return h;
}
