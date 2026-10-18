/*
 * The order operations run in (Core Server §5.2). An op runs in a scope: the app's, a canvas's or
 * an agent's, given as a path (app, then the canvas, then the agent). Ops in one scope run one at a
 * time, in the order they came, so an async op (starting a session) is never overtaken by the next
 * op on its agent. Ops in other scopes, and ops with none (reads, `wait`), run at once. A preempting
 * op (an interrupt, a stop, a kill, a withdraw) skips its scope's queue: it aborts what runs in its
 * scope and in the scopes beneath it, waits for that to unwind, and runs ahead of what is queued, so
 * a stop is never stuck behind a slow start. Preempting ops never abort each other (two withdraws
 * both take their message back): those that overlap run one at a time, in the order they came. Each
 * op gets a signal that aborts when it is superseded or its caller gives up; it unwinds by itself.
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
  controller: AbortController;
  /** Resolves once the op has unwound. */
  settled: Promise<void>;
}

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
   * Runs `op` in the scope `path` (null: none), preempting if `preempt`, with `signal` the
   * caller's. Rejects without running `op` if the caller gives up while it waits its turn.
   */
  async run<T>(
    path: readonly string[] | null,
    preempt: boolean,
    signal: AbortSignal | undefined,
    op: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (path === null) return op(signal ?? new AbortController().signal);
    const key = keyOf(path);
    const lane = this.#lane(key);
    if (preempt) {
      lane.held++;
      try {
        await this.#supersede(path);
      } finally {
        lane.held--;
      }
    }
    return this.#enter(lane, key, path, preempt, signal, op);
  }

  #lane(key: string): Lane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { running: undefined, preempts: [], queue: [], held: 0 };
      this.#lanes.set(key, lane);
    }
    return lane;
  }

  /** Aborts what runs in the scope `path` and beneath it, but for preempting ops, and waits for it. */
  async #supersede(path: readonly string[]): Promise<void> {
    const beneath = [...this.#lanes.values()].flatMap(({ running }) =>
      running && !running.preempt && path.every((part, i) => running.path[i] === part)
        ? [running]
        : [],
    );
    for (const { controller } of beneath) controller.abort(new Superseded());
    await Promise.all(beneath.map(({ settled }) => settled));
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
    op: (signal: AbortSignal) => Promise<T>,
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
        this.#start(lane, key, path, preempt, signal, op).then(resolve, reject);
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

  async #start<T>(
    lane: Lane,
    key: string,
    path: readonly string[],
    preempt: boolean,
    signal: AbortSignal | undefined,
    op: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const settled = Promise.withResolvers<undefined>();
    lane.running = { path, preempt, controller, settled: settled.promise };
    try {
      return await op(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
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
