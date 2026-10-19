/*
 * The order operations run in (Core Server §5.2, B9 Design §3). An op runs in a scope: the app's, a
 * canvas's or an agent's, given as a path (app, then the canvas, then the agent). Ops in one scope
 * run one at a time, in the order they came, so an async op (starting a session) is never overtaken
 * by the next op on its agent. Ops in other scopes, and ops with none (reads, `wait`), run at once.
 * A preempting op (an interrupt, a stop, a kill, a withdraw) skips its scope's queue: it aborts what
 * runs in its scope and in the scopes beneath it, waits for that to unwind, and runs ahead of what
 * is queued, so a stop is never stuck behind a slow start. Preempting ops never abort each other
 * (two withdraws both take their message back): those that overlap run one at a time, in the order
 * they came. A draining op (closing a canvas, deleting an agent) aborts what runs beneath its scope
 * in the scopes it drains as it comes, and takes its turn in its own scope's queue as usual, never
 * jumping it: it starts once its turn comes and what it aborted has unwound. Each op gets a signal
 * that aborts when it is superseded or its caller gives up; it unwinds by itself, until it says it
 * is past its point of no return (a commit queued): then nothing aborts it, and what would have
 * waits for it to end.
 */

/** Why an op's signal aborted: a preempting op in its scope superseded it. */
export class Superseded extends Error {
  constructor() {
    super('Stopped by another call in its scope.');
    this.name = 'Superseded';
  }
}

interface Running {
  path: readonly string[];
  preempt: boolean;
  /** Whether it is past its point of no return: aborted by nothing from then on. */
  past: boolean;
  controller: AbortController;
  /** Resolves once the op has unwound. */
  settled: Promise<void>;
}

/** How an op takes its turn: ahead of its scope's queue, or after draining scopes beneath it. */
export interface Turn {
  preempt?: boolean;
  /**
   * The scopes (paths) it drains: what runs in them, or beneath them, deeper than its own scope, is
   * aborted as it comes.
   */
  drains?: readonly (readonly string[])[];
}

/** An op: what it does with its signal, saying when it is past its point of no return. */
export type ScopedOp<T> = (signal: AbortSignal, noReturn: () => void) => Promise<T>;

interface Lane {
  running: Running | undefined;
  /** The preempting ops waiting their turn, in order: they go before `queue`. */
  preempts: (() => void)[];
  /** The other ops waiting their turn, in order. Each entry starts its op, at once, when called. */
  queue: (() => void)[];
  /** How many preempting ops wait for what they aborted to unwind, holding the lane meanwhile. */
  held: number;
}

const keyOf = (path: readonly string[]) => path.join('\u0000');

export class Scopes {
  readonly #lanes = new Map<string, Lane>();

  /**
   * Runs `op` in the scope `path` (null: none), taking its turn as `turn` says, with `signal` the
   * caller's. Rejects without running `op` if the caller gives up while it waits its turn.
   */
  async run<T>(
    path: readonly string[] | null,
    { preempt = false, drains = [] }: Turn,
    signal: AbortSignal | undefined,
    op: ScopedOp<T>,
  ): Promise<T> {
    if (path === null) return op(signal ?? new AbortController().signal, () => undefined);
    const key = keyOf(path);
    const lane = this.#lane(key);
    if (preempt) {
      lane.held++;
      try {
        await this.#stop(this.#within([path], 0));
      } finally {
        lane.held--;
      }
      return this.#enter(lane, key, path, true, signal, op);
    }
    const drained =
      drains.length === 0 ? undefined : this.#stop(this.#within(drains, path.length + 1));
    return this.#enter(lane, key, path, false, signal, op, drained);
  }

  #lane(key: string): Lane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { running: undefined, preempts: [], queue: [], held: 0 };
      this.#lanes.set(key, lane);
    }
    return lane;
  }

  /**
   * What runs, but for preempting ops, in the scopes `paths` or beneath them, in a scope at least
   * `depth` deep.
   */
  #within(paths: readonly (readonly string[])[], depth: number): Running[] {
    return [...this.#lanes.values()].flatMap(({ running }) =>
      running &&
      !running.preempt &&
      running.path.length >= depth &&
      paths.some((path) => path.every((part, i) => running.path[i] === part))
        ? [running]
        : [],
    );
  }

  /** Aborts `ops`, but those past their point of no return, and waits for all of them to end. */
  async #stop(ops: readonly Running[]): Promise<void> {
    for (const { past, controller } of ops) if (!past) controller.abort(new Superseded());
    await Promise.all(ops.map(({ settled }) => settled));
  }

  /**
   * Runs `op` once its lane is free and the ops before it are done (a preempting op's turn comes
   * before the queue's), or rejects if the caller gives up first.
   */
  #enter<T>(
    lane: Lane,
    key: string,
    path: readonly string[],
    preempt: boolean,
    signal: AbortSignal | undefined,
    op: ScopedOp<T>,
    drained?: Promise<void>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        // What it held the lane for may have unwound meanwhile: the next op goes.
        this.#next(key, lane);
        reject(signal.reason as Error);
        return;
      }
      const waiting = preempt ? lane.preempts : lane.queue;
      const start = () => {
        signal?.removeEventListener('abort', gaveUp);
        this.#start(lane, key, path, preempt, signal, op, drained).then(resolve, reject);
      };
      const gaveUp = () => {
        waiting.splice(waiting.indexOf(start), 1);
        this.#forget(key, lane);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', gaveUp, { once: true });
      waiting.push(start);
      this.#next(key, lane);
    });
  }

  /**
   * Starts the next op waiting in a lane that nothing runs in or holds: the first preempting one,
   * else the first queued. Nothing can start in between, so one op at a time runs in the lane.
   */
  #next(key: string, lane: Lane): void {
    if (lane.running || lane.held > 0) return;
    const next = lane.preempts.shift() ?? lane.queue.shift();
    if (next) next();
    else this.#forget(key, lane);
  }

  /** Runs `op` in its lane, once what it drains (`drained`) has unwound. */
  async #start<T>(
    lane: Lane,
    key: string,
    path: readonly string[],
    preempt: boolean,
    signal: AbortSignal | undefined,
    op: ScopedOp<T>,
    drained: Promise<void> | undefined,
  ): Promise<T> {
    const controller = new AbortController();
    const settled = Promise.withResolvers<undefined>();
    const running: Running = {
      path,
      preempt,
      past: false,
      controller,
      settled: settled.promise,
    };
    lane.running = running;
    try {
      if (drained !== undefined) {
        await drained;
        // Superseded, or given up on, while it waited.
        controller.signal.throwIfAborted();
        signal?.throwIfAborted();
      }
      return await op(
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        () => {
          running.past = true;
        },
      );
    } finally {
      lane.running = undefined;
      settled.resolve(undefined);
      this.#next(key, lane);
    }
  }

  /** Drops a lane with nothing running, held or waiting. */
  #forget(key: string, lane: Lane): void {
    if (!lane.running && lane.held === 0 && lane.preempts.length + lane.queue.length === 0) {
      this.#lanes.delete(key);
    }
  }
}
