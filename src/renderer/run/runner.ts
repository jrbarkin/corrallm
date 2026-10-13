import type { GraphNode } from '../graph/graph';
import { isApproval, isDelay, isIf, isMessage, isPause, isWait, unfit } from '../graph/queue';
import type { Condition, QueueItem, QueueMessage, QueueStep, WaitTarget } from '../graph/queue';
import { deadline } from '../graph/time';

/**
 * How a task went. skipped: an if-then whose condition did not hold (or cannot, where it sits), or
 * an empty message. timedOut: a wait that went on without what it waited for, its time limit past
 * (or the user said to go on). stopped: an OK the user stopped its queue at.
 */
export type Outcome = 'succeeded' | 'failed' | 'skipped' | 'timedOut' | 'stopped';

/** Where an agent's queue is, in a run. */
export interface AgentRun {
  /** The task it is on: an item of its queue, or a step of an if-then (by id). */
  current?: string;
  /**
   * running: doing its task (or, at an OK, the changes the user asked for). waiting: held by the
   * run, at a wait or a delay. asking: held for the user, at an OK. stopped: stopped at an OK, or
   * at a wait for what was stopped. done: past the end of its queue.
   */
  status: 'running' | 'waiting' | 'asking' | 'stopped' | 'done';
  /** While held at a delay, or at a wait with a time limit: when that time comes (epoch ms). */
  until?: number;
  /** How each task it has finished went, by id. */
  outcomes: Readonly<Record<string, Outcome>>;
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
 * for and it asks again, or the queue stops there, and with it whatever waits on it. Queues are
 * read as they run (`update` gives it the graph as it changes), so edits take effect at once.
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
  /** Whether each if-then's condition held, once decided (by agent and if-then). */
  readonly #held = new Map<string, boolean>();
  /** When each agent reached the delay or wait it is (or was) held at (by agent and item). */
  readonly #arrived = new Map<string, number>();
  /** The holds the user said to go on from (Go on now), by agent and item. */
  readonly #ended = new Set<string>();
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
    this.#ended.add(JSON.stringify([agent, item]));
    this.#settle(false);
  }

  /**
   * Answers the hold an agent is at for the user (`item`, an OK). `{ choice: 'approve' }`: its
   * queue goes on, and so do waits for it. `{ choice: 'stop' }`: its queue stops there, and with it
   * every wait for it, for what comes after it, or for all of its agent's work. `{ reply }`: the
   * changes the user asks for, sent as they are (trimmed; empty, nothing is asked) to the agent's
   * session; once that turn ends, it asks again. Only while the run holds that agent at that item
   * for the user, so a second click, a stale card or an answer after Stop does nothing.
   */
  decide(agent: string, item: string, answer: Answer): void {
    const at = this.#run.agents[agent];
    if (!this.#run.running || at?.status !== 'asking' || at.current !== item) return;
    const node = this.#agents().find((n) => n.id === agent);
    const ok = node?.data.queue?.find((q) => q.id === item);
    if (!node || !ok || !isApproval(ok)) return;
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
   * Where an agent not busy with a task goes next: its next task, a hold (a wait, a delay, an OK),
   * a stop, or done. What the user asked for at its OKs goes with it.
   */
  #advance(
    node: GraphNode,
    run: AgentRun,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun {
    const next = this.#next(node, run.outcomes, agents, now);
    return run.changes ? { ...next, changes: run.changes } : next;
  }

  /** Where in its queue an agent goes next, from how the tasks it has done went (`done`). */
  #next(
    node: GraphNode,
    done: Readonly<Record<string, Outcome>>,
    agents: Readonly<Record<string, AgentRun>>,
    now: number,
  ): AgentRun {
    const outcomes: Record<string, Outcome> = { ...done };
    const queue = node.data.queue ?? [];
    for (const [index, item] of queue.entries()) {
      // Stopped at an OK: nothing after it runs.
      if (outcomes[item.id] === 'stopped') return { current: item.id, status: 'stopped', outcomes };
      if (outcomes[item.id] !== undefined) continue;
      const key = JSON.stringify([node.id, item.id]);
      // Only the user moves the queue on from an OK (decide): no time, and no chance.
      if (isApproval(item)) return { current: item.id, status: 'asking', outcomes };
      if (isDelay(item)) {
        const until = deadline(item.delay, this.#arrive(key, now));
        if (!this.#ended.has(key) && now < until)
          return { current: item.id, status: 'waiting', until, outcomes };
        outcomes[item.id] = 'succeeded';
        continue;
      }
      if (isWait(item)) {
        const results = item.waitFor.map((target) => this.#resultOf(target, agents));
        // A stop wins over everything, a time limit too: what it waits for will never be done.
        if (results.includes('stopped')) return { current: item.id, status: 'stopped', outcomes };
        if (results.every((result) => result !== undefined)) {
          outcomes[item.id] = results.includes('failed') ? 'failed' : 'succeeded';
          continue;
        }
        // Arrival counts for a limit added while it waits, too.
        const arrived = this.#arrive(key, now);
        const until = item.timeout && deadline(item.timeout, arrived);
        if (this.#ended.has(key) || (until !== undefined && now >= until)) {
          outcomes[item.id] = 'timedOut';
          continue;
        }
        return {
          current: item.id,
          status: 'waiting',
          ...(until === undefined ? {} : { until }),
          outcomes,
        };
      }
      if (isIf(item)) {
        const held =
          this.#held.get(key) ??
          (unfit(queue, index) === undefined &&
            this.#holds(item.if, lastRan(queue.slice(0, index), outcomes)));
        this.#held.set(key, held);
        if (!held) {
          outcomes[item.id] = 'skipped';
          continue;
        }
        const step = item.then.find((s) => outcomes[s.id] === undefined);
        if (step) return this.#begin(node.id, step, outcomes);
        const last = item.then.at(-1);
        outcomes[item.id] = (last && outcomes[last.id]) ?? 'succeeded';
        continue;
      }
      return this.#begin(node.id, item, outcomes);
    }
    return { status: 'done', outcomes };
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
   * outcome of its last task that ran. What is gone counts as done, and well.
   */
  #resultOf(target: WaitTarget, agents: Readonly<Record<string, AgentRun>>): Outcome | undefined {
    const node = this.#agents().find((n) => n.id === target.agent);
    if (!node) return 'succeeded';
    const run = agents[target.agent];
    const stopped = run?.status === 'stopped';
    if (target.item === undefined) {
      if (stopped) return 'stopped';
      if (run?.status !== 'done') return undefined;
      return lastRan(node.data.queue ?? [], run.outcomes) ?? 'succeeded';
    }
    if (!node.data.queue?.some((item) => item.id === target.item)) return 'succeeded';
    const outcome = run?.outcomes[target.item];
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

  /** Forgets what the last run decided and when it reached its holds, to run from the top. */
  #forget(): void {
    this.#held.clear();
    this.#arrived.clear();
    this.#ended.clear();
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
 * The outcome of the last of `items` that ran: what an if-then checks, and how a wait for all of an
 * agent's work went. Items not done yet, skipped ones, and pauses (delays and OKs, which only hold
 * the queue: queue.ts isPause) are passed over.
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
