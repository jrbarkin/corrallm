import type { GraphNode } from '../graph/graph';
import {
  findItem,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isPause,
  isRepeat,
  isRepeatEnds,
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
  WaitTarget,
} from '../graph/queue';
import { deadline } from '../graph/time';

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
   * run, at a wait or a delay. asking: held for the user, at an OK or a repeat out of rounds.
   * stopped: stopped at an OK, or at a wait for what was stopped. done: past the end of its queue.
   */
  status: 'running' | 'waiting' | 'asking' | 'stopped' | 'done';
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
 * offers them), or a reply in their words.
 */
export type Answer = { choice: string } | { reply: string };

/** What a run needs from its surroundings. */
export interface RunIO {
  /** Sends a message to an agent's session; `done` once the turn it starts ends. */
  send: (agent: GraphNode, text: string, done?: (failed: boolean) => void) => void;
  /** Runs `run` in `ms`; returns a function that cancels it. */
  later: (run: () => void, ms: number) => () => void;
  /** The time now (epoch ms): the only clock a run reads, for its delays and time limits. */
  now: () => number;
  /** A random number from 0 up to 1: whether a step fails, or an agent judges a condition holds. */
  chance: () => number;
}

/** How long a step takes, at least and at most; and handing a message to another agent. */
const STEP_MS = [1500, 3500] as const;
const HANDOFF_MS = 700;
/**
 * The longest the run sleeps before it looks at the clock again while a delay or a time limit
 * holds an agent: a timer can fire late (a sleeping laptop) and the clock can be changed.
 */
const ALARM_MS = 60_000;
/** How likely a step is to fail, and an agent to judge a condition in its own words to hold. */
const FAILS = 0.25;
const HOLDS = 0.5;

const IDLE: Run = { running: false, agents: {} };

/**
 * Runs every agent's queue, simulated until agents are connected (like their sessions): each
 * agent works through its queue in order. A step takes a few seconds and may fail; a message to
 * the agent goes to its session (sessions.ts) and is done when the turn it starts ends; a message
 * to another agent is handed to that agent's session. A wait holds until what it waits for is
 * done (a step, or all of an agent's work), or its time limit passes; a delay holds until its time
 * has come; an if-then runs its steps only if its condition holds of the task before it. Delays
 * and time limits are the run's own, on the real clock (`now`): no agent is asked to wait. An OK
 * holds until the user decides (`decide`): the queue goes on, the agent makes the changes asked
 * for and it asks again, or the queue stops there, and with it whatever waits on it. A repeat
 * runs what it holds in rounds, until its condition holds of a round's last task that ran, at
 * most its rounds; then it goes on having failed, or asks the user for one more round. A wait in a
 * repeat for a step in another repeat waits for it in the same round; a wait outside one, for that
 * repeat to end. A repeat that follows another goes round with it, and ends with it. Rounds, like
 * delays, are the run's: the agent is only sent each round's messages. Queues are read as they run
 * (`update` gives it the graph as it changes), so edits take effect at once.
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

  /** Stops where the queues are: no task goes on, and none starts. */
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
   * changes the user asks for, sent as they are (trimmed; empty, nothing is asked) to the agent's
   * session, and once that turn ends, it asks again. At a repeat out of rounds: `{ choice: 'more' }`
   * runs one more round; `{ choice: 'goOn' }` ends it as failed, and its queue goes on; `{ reply }`
   * sends what to try next to the agent (not waited for), then runs one more round. Only while the
   * run holds that agent at that item for the user, so a second click, a stale card or an answer
   * after Stop does nothing.
   */
  decide(agent: string, item: string, answer: Answer): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || at?.status !== 'asking' || at.current !== item) return;
    const node = this.#agents().find((n) => n.id === agent);
    const held = node && findItem(node.data.queue ?? [], item)?.item;
    if (!node || !held) return;
    if (isRepeat(held)) {
      this.#decideRounds(node, at, held, answer);
      return;
    }
    if (!isApproval(held)) return;
    if ('reply' in answer) {
      this.#askForChanges(node, at, item, answer.reply.trim());
      return;
    }
    const outcome =
      answer.choice === 'approve' ? 'succeeded' : answer.choice === 'stop' ? 'stopped' : undefined;
    if (outcome === undefined) return;
    this.#record(agent, item, outcome);
    this.#settle(true);
  }

  /** The graph as it is now: a run goes on with new work, and past waits for what is gone. */
  update(nodes: readonly GraphNode[]): void {
    this.#nodes = nodes;
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
      const until = deadline(item.delay, this.#arrive(key, now));
      if (!this.#ended.has(key) && now < until)
        return { current: item.id, status: 'waiting', until, outcomes };
      return 'succeeded';
    }
    if (!isWait(item)) return this.#begin(agent, item, outcomes);
    const results = item.waitFor.map((target) => this.#resultOf(target, agents, round));
    // A stop wins over everything, a time limit too: what it waits for will never be done.
    if (results.includes('stopped')) return { current: item.id, status: 'stopped', outcomes };
    if (results.every((result) => result !== undefined))
      return results.includes('failed') ? 'failed' : 'succeeded';
    // Arrival counts for a limit added while it waits, too.
    const arrived = this.#arrive(key, now);
    const until = item.timeout && deadline(item.timeout, arrived);
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
   * is decided once, of the task before it, and is skipped where it cannot hold.
   */
  #ifThen(
    node: GraphNode,
    item: QueueIf,
    index: number,
    outcomes: Record<string, Outcome>,
  ): AgentRun | Outcome {
    const queue = node.data.queue ?? [];
    const key = JSON.stringify([node.id, item.id]);
    const held =
      this.#held.get(key) ??
      (unfit(queue, index) === undefined &&
        this.#holds(item.if, lastRan(queue.slice(0, index), outcomes)));
    this.#held.set(key, held);
    if (!held) return 'skipped';
    const step = item.then.find((s) => outcomes[s.id] === undefined);
    if (step) return this.#begin(node.id, step, outcomes);
    const last = item.then.at(-1);
    return (last && outcomes[last.id]) ?? 'succeeded';
  }

  /**
   * A repeat the queue reached (`before`: the items above it): where it is in its round now, or
   * once it is over, how it went. Each round runs what it holds in order, as a queue runs; at its
   * end, the condition is decided (once) of the round's last task that ran (or the last before the
   * repeat, if none did). If it holds, the repeat succeeded; if not, the next round starts, afresh,
   * while rounds are left (`rounds`, and those the user added); then it fails and goes on, or asks
   * the user. A repeat that follows another instead goes round when that one does (#follow), and
   * ends with it. Rounds that end at once run on here, no further than the rounds left.
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
        const held =
          this.#held.get(key) ??
          this.#holds(until, lastRan(repeat.repeat, outcomes) ?? lastRan(before, outcomes));
        this.#held.set(key, held);
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
      return lastRan(node.data.queue ?? [], run.outcomes) ?? 'succeeded';
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

  #holds(condition: Condition, previous: Outcome | undefined): boolean {
    switch (condition.kind) {
      case 'succeeded':
        return previous === 'succeeded';
      case 'failed':
        return previous === 'failed';
      case 'timedOut':
        return previous === 'timedOut';
      case 'outputContains':
      case 'freeText':
        return this.#io.chance() < HOLDS;
    }
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

  /** Starts a task: the agent is busy with it until it finishes. */
  #begin(
    agent: string,
    task: QueueStep | QueueMessage,
    outcomes: Record<string, Outcome>,
  ): AgentRun {
    const token = {};
    this.#busy.set(agent, token);
    const finish = (outcome: Outcome) => {
      this.#finish(agent, task.id, token, outcome);
    };
    const own = task.target === undefined || task.target === agent;
    if (!isMessage(task)) {
      const [least, most] = STEP_MS;
      const ms = least + (hash(task.id) % (most - least));
      this.#after(ms, () => {
        finish(this.#io.chance() < FAILS ? 'failed' : 'succeeded');
      });
    } else if (task.message.trim() === '') {
      this.#after(0, () => {
        finish('skipped');
      });
    } else {
      const to = this.#agents().find((n) => n.id === (own ? agent : task.target));
      if (to && own) {
        this.#io.send(to, task.message, (failed) => {
          finish(failed ? 'failed' : 'succeeded');
        });
      } else {
        if (to) this.#io.send(to, task.message);
        this.#after(HANDOFF_MS, () => {
          finish('succeeded');
        });
      }
    }
    return { current: task.id, status: 'running', outcomes };
  }

  /**
   * Answers a repeat out of rounds: one more round (`more`), first sending the agent what to try
   * next (`reply`, not waited for: its session runs it before the round's first message); or go on
   * (`goOn`), the repeat failed.
   */
  #decideRounds(node: GraphNode, at: AgentRun, repeat: QueueRepeat, answer: Answer): void {
    if ('reply' in answer) {
      const note = answer.reply.trim();
      if (note === '') return;
      this.#io.send(node, note);
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
   * Sends the changes the user asked for at an OK to the queue's own agent, as a turn of its
   * session: it works on them at the OK, and once the turn ends (however it ends) the OK asks again.
   */
  #askForChanges(node: GraphNode, at: AgentRun, ok: string, note: string): void {
    if (note === '') return;
    const token = {};
    this.#busy.set(node.id, token);
    const changes = { ...at.changes, [ok]: [...(at.changes?.[ok] ?? []), note] };
    const run: AgentRun = { ...at, status: 'running', changes };
    this.#set({ ...this.#run, agents: { ...this.#run.agents, [node.id]: run } });
    this.#io.send(node, note, () => {
      if (this.#busy.get(node.id) !== token) return;
      this.#busy.delete(node.id);
      this.#settle(true);
    });
  }

  #finish(agent: string, task: string, token: object, outcome: Outcome): void {
    if (this.#busy.get(agent) !== token) return;
    this.#busy.delete(agent);
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

  #cancel(): void {
    for (const cancel of this.#timers) cancel();
    this.#timers.clear();
    this.#busy.clear();
    this.#alarm?.cancel();
    this.#alarm = undefined;
  }

  /**
   * Forgets what the last run decided (its if-thens, its repeats' rounds) and when it reached its
   * holds, to run from the top.
   */
  #forget(): void {
    this.#held.clear();
    this.#arrived.clear();
    this.#ended.clear();
    this.#past.clear();
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
 * The outcome of the last of `items` that ran: what an if-then checks, what a repeat's condition
 * is decided of at the end of a round, and how a wait for all of an agent's work went. Items not
 * done yet, skipped ones, and pauses (delays and OKs, which only hold the queue: queue.ts isPause)
 * are passed over.
 */
function lastRan(
  items: readonly QueueItem[],
  outcomes: Readonly<Record<string, Outcome>>,
): Outcome | undefined {
  for (const item of items.toReversed()) {
    const outcome = outcomes[item.id];
    if (outcome !== undefined && outcome !== 'skipped' && !isPause(item)) return outcome;
  }
  return undefined;
}

/** A number from a string, the same each time: steps take their own, steady time. */
function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return h;
}
