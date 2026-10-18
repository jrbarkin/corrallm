/*
 * The order operations run in (Core Server §5.2). An op runs in a scope: the app's, a canvas's or
 * an agent's, given as a path (app, then the canvas, then the agent). Ops in one scope run one at a
 * time, in the order they came, so an async op (starting a session) is never overtaken by the next
 * op on its agent. Ops in other scopes, and ops with none (reads, `wait`), run at once. A preempting
 * op (an interrupt, a stop, a kill, a withdraw) skips its scope's queue: it aborts what runs in its
 * scope and in the scopes beneath it, waits for that to unwind, and runs ahead of what is queued, so
 * a stop is never stuck behind a slow start. Each op gets a signal that aborts when it is
 * superseded or its caller gives up; it unwinds by itself.
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
  controller: AbortController;
  /** Resolves once the op has unwound. */
  settled: Promise<void>;
}

interface Lane {
  running: Running | undefined;
  /** What waits to run, in order: each starts its op, at once, when called. */
  queue: (() => void)[];
  /** How many preempting ops wait for this lane's op to unwind, holding the queue meanwhile. */
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
    } else if (lane.running || lane.held > 0 || lane.queue.length > 0) {
      return this.#queue(lane, key, path, signal, op);
    }
    return this.#start(lane, key, path, signal, op);
  }

  #lane(key: string): Lane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { running: undefined, queue: [], held: 0 };
      this.#lanes.set(key, lane);
    }
    return lane;
  }

  /**
   * Runs `op` once the ops before it in its lane are done, starting it as the last one ends (so
   * nothing can start in between), or rejects if the caller gives up first.
   */
  #queue<T>(
    lane: Lane,
    key: string,
    path: readonly string[],
    signal: AbortSignal | undefined,
    op: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted();
      const start = () => {
        signal?.removeEventListener('abort', gaveUp);
        this.#start(lane, key, path, signal, op).then(resolve, reject);
      };
      const gaveUp = () => {
        lane.queue.splice(lane.queue.indexOf(start), 1);
        this.#forget(key, lane);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', gaveUp, { once: true });
      lane.queue.push(start);
    });
  }

  /** Aborts what runs in the scope `path` and beneath it, and waits for it to unwind. */
  async #supersede(path: readonly string[]): Promise<void> {
    const beneath = [...this.#lanes.values()].flatMap(({ running }) =>
      running && path.every((part, i) => running.path[i] === part) ? [running] : [],
    );
    for (const { controller } of beneath) controller.abort(new Superseded());
    await Promise.all(beneath.map(({ settled }) => settled));
  }

  async #start<T>(
    lane: Lane,
    key: string,
    path: readonly string[],
    signal: AbortSignal | undefined,
    op: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const settled = Promise.withResolvers<undefined>();
    lane.running = { path, controller, settled: settled.promise };
    try {
      return await op(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    } finally {
      lane.running = undefined;
      settled.resolve(undefined);
      const next = lane.held === 0 ? lane.queue.shift() : undefined;
      if (next) next();
      else this.#forget(key, lane);
    }
  }

  /** Drops a lane with nothing running, held or queued. */
  #forget(key: string, lane: Lane): void {
    if (!lane.running && lane.held === 0 && lane.queue.length === 0) this.#lanes.delete(key);
  }
}
