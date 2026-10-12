import type { GraphNode } from '../graph/graph';
import { isIf, isMessage, isWait } from '../graph/queue';
import type { Condition, QueueMessage, QueueStep, WaitTarget } from '../graph/queue';

/** How a task went; skipped: an if-then whose condition did not hold, or an empty message. */
export type Outcome = 'succeeded' | 'failed' | 'skipped';

/** Where an agent's queue is, in a run. */
export interface AgentRun {
  /** The task it is on: an item of its queue, or a step of an if-then (by id). */
  current?: string;
  /** Doing its task; held at a wait; or past the end of its queue. */
  status: 'running' | 'waiting' | 'done';
  /** How each task it has finished went, by id. */
  outcomes: Readonly<Record<string, Outcome>>;
}

export interface Run {
  /** Whether queues are running: an agent is doing a task, or waiting for one. */
  running: boolean;
  agents: Readonly<Record<string, AgentRun>>;
}

/** What a run needs from its surroundings. */
export interface RunIO {
  /** Sends a message to an agent's session; `done` once the turn it starts ends. */
  send: (agent: GraphNode, text: string, done?: (failed: boolean) => void) => void;
  /** Runs `run` in `ms`; returns a function that cancels it. */
  later: (run: () => void, ms: number) => () => void;
  /** A random number from 0 up to 1: whether a step fails, or an agent judges a condition holds. */
  chance: () => number;
}

/** How long a step takes, at least and at most; and handing a message to another agent. */
const STEP_MS = [1500, 3500] as const;
const HANDOFF_MS = 700;
/** How likely a step is to fail, and an agent to judge a condition in its own words to hold. */
const FAILS = 0.25;
const HOLDS = 0.5;

const IDLE: Run = { running: false, agents: {} };

/**
 * Runs every agent's queue, simulated until agents are connected (like their sessions): each
 * agent works through its queue in order. A step takes a few seconds and may fail; a message to
 * the agent goes to its session (sessions.ts) and is done when the turn it starts ends; a message
 * to another agent is handed to that agent's session. A wait holds until what it waits for is
 * done (a step, or all of an agent's work); an if-then runs its steps only if its condition holds
 * of the task before it. Queues are read as they run (`update` gives it the graph as it changes),
 * so edits take effect at once.
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
    this.#held.clear();
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
    this.#held.clear();
    this.#set(IDLE);
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
    for (let again = true; again;) {
      again = false;
      for (const node of nodes) {
        if (this.#busy.has(node.id)) continue;
        const before = agents[node.id];
        const after = this.#advance(node, before ?? { status: 'done', outcomes: {} }, agents);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        agents = { ...agents, [node.id]: after };
        again = true;
        moved = true;
      }
    }
    const running =
      this.#busy.size > 0 || Object.values(agents).some((run) => run.status === 'waiting');
    if (moved || running !== this.#run.running) this.#set({ running, agents });
  }

  /** Where an agent not busy with a task goes next: its next task, a wait that holds, or done. */
  #advance(node: GraphNode, run: AgentRun, agents: Readonly<Record<string, AgentRun>>): AgentRun {
    const outcomes: Record<string, Outcome> = { ...run.outcomes };
    let previous: Outcome | undefined;
    for (const item of node.data.queue ?? []) {
      const known = outcomes[item.id];
      if (known !== undefined) {
        previous = known;
        continue;
      }
      if (isWait(item)) {
        if (!item.waitFor.every((target) => this.#doneWith(target, agents)))
          return { current: item.id, status: 'waiting', outcomes };
        previous = outcomes[item.id] = 'succeeded';
        continue;
      }
      if (isIf(item)) {
        const key = JSON.stringify([node.id, item.id]);
        const held = this.#held.get(key) ?? this.#holds(item.if, previous);
        this.#held.set(key, held);
        if (!held) {
          previous = outcomes[item.id] = 'skipped';
          continue;
        }
        const step = item.then.find((s) => outcomes[s.id] === undefined);
        if (step) return this.#begin(node.id, step, outcomes);
        const last = item.then.at(-1);
        previous = outcomes[item.id] = (last && outcomes[last.id]) ?? 'succeeded';
        continue;
      }
      return this.#begin(node.id, item, outcomes);
    }
    return { status: 'done', outcomes };
  }

  /** Whether a wait's target is done: a step done (or gone), or an agent done with all its work. */
  #doneWith(target: WaitTarget, agents: Readonly<Record<string, AgentRun>>): boolean {
    const node = this.#agents().find((n) => n.id === target.agent);
    if (!node) return true;
    const run = agents[target.agent];
    if (target.item === undefined) return run?.status === 'done';
    if (!node.data.queue?.some((item) => item.id === target.item)) return true;
    return run?.outcomes[target.item] !== undefined;
  }

  #holds(condition: Condition, previous: Outcome | undefined): boolean {
    switch (condition.kind) {
      case 'succeeded':
        return previous === 'succeeded';
      case 'failed':
        return previous === 'failed';
      case 'outputContains':
      case 'freeText':
        return this.#io.chance() < HOLDS;
    }
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

  #finish(agent: string, task: string, token: object, outcome: Outcome): void {
    if (this.#busy.get(agent) !== token) return;
    this.#busy.delete(agent);
    const run = this.#run.agents[agent];
    if (run) {
      const outcomes = { ...run.outcomes, [task]: outcome };
      this.#run = { ...this.#run, agents: { ...this.#run.agents, [agent]: { ...run, outcomes } } };
    }
    this.#settle(true);
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
  }

  #set(run: Run): void {
    this.#run = run;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Where a run is with a task of an agent's (by id; null: the end of its queue), as views mark it:
 * running it or held at it (stopped, once the run is), how it went, or the end reached.
 */
export function taskState(run: Run, agent: string, item: string | null): string | undefined {
  const at = run.agents[agent];
  if (!at) return undefined;
  if (item === null) return at.status === 'done' ? 'reached' : undefined;
  if (at.current === item && at.status !== 'done') return run.running ? at.status : 'stopped';
  return at.outcomes[item];
}

/** A number from a string, the same each time: steps take their own, steady time. */
function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return h;
}
