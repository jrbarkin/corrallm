/*
 * The order operations run in (Core Server §5.2, B9 Design §3). An op runs in a scope: the app's, a
 * canvas's or an agent's, given as a path (app, then the canvas, then the agent). Ops in one scope
 * run one at a time, in the order they came, so an async op (starting a session) is never overtaken
 * by the next op on its agent. Ops in other scopes, and ops with none (reads, `wait`), run at once.
 * A preempting op (an interrupt, a stop, a kill, a withdraw) skips its scope's queue: it aborts what
 * runs in its scope and in the scopes beneath it, waits for that to unwind, and runs ahead of what
 * is queued, so a stop is never stuck behind a slow start. Preempting ops never abort each other
 * (two withdraws both take their message back): those that overlap run one at a time, in the order
 * they came. A draining op (closing a canvas, deleting an agent) holds the scopes it drains beneath
 * its own from the moment it comes until it ends, so nothing runs on what it removes or switches
 * meanwhile: it aborts what runs there (a preempting op it lets finish), supersedes what waits
 * there, and starts nothing there until it ends (what comes meanwhile waits for it). It takes its
 * turn in its own scope's queue as usual, never jumping it: it starts once its turn comes and what
 * runs in the scopes it drains has unwound. Each op gets a signal that aborts when it is
 * superseded or its caller gives up; it unwinds by itself, until it says it is past its point of no
 * return (a commit queued): then nothing aborts it, and what would have waits for it to end.
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
   * The scopes (paths) it drains: those deeper than its own scope, in them or beneath them, are
   * held from when it comes until it ends, what runs there aborted and what waits there superseded.
   */
  drains?: readonly (readonly string[])[];
}

/** The scopes a draining op holds: those in or beneath `paths`, at least `depth` deep. */
interface Drain {
  paths: readonly (readonly string[])[];
  depth: number;
}

/** An op: what it does with its signal, saying when it is past its point of no return. */
export type ScopedOp<T> = (signal: AbortSignal, noReturn: () => void) => Promise<T>;

/** An op waiting its turn: what starts it, at once, and what refuses it, superseded. */
interface Waiting {
  start: () => void;
  supersede: () => void;
}

interface Lane {
  path: readonly string[];
  running: Running | undefined;
  /** The preempting ops waiting their turn, in order: they go before `queue`. */
  preempts: Waiting[];
  /** The other ops waiting their turn, in order. */
  queue: Waiting[];
  /** How many preempting ops wait for what they aborted to unwind, holding the lane meanwhile. */
  held: number;
}

const keyOf = (path: readonly string[]) => path.join('\u0000');

export class Scopes {
  readonly #lanes = new Map<string, Lane>();
  /** What the draining ops that came and haven't ended hold. */
  readonly #drains = new Set<Drain>();

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
    const lane = this.#lane(key, path);
    if (preempt) {
      const held: Drain = { paths: [path], depth: path.length + 1 };
      this.#drains.add(held);
      try {
        lane.held++;
        try {
          await this.#stop(this.#beneath(path));
        } finally {
          lane.held--;
        }
        return await this.#enter(lane, key, path, true, signal, op);
      } finally {
        this.#release(held);
      }
    }
    if (drains.length === 0) return this.#enter(lane, key, path, false, signal, op);
    const drain: Drain = { paths: drains, depth: path.length + 1 };
    this.#drains.add(drain);
    try {
      return await this.#enter(lane, key, path, false, signal, op, this.#drain(drain));
    } finally {
      this.#release(drain);
    }
  }

  #release(drain: Drain): void {
    this.#drains.delete(drain);
    for (const [key, lane] of this.#lanes) if (holds(drain, lane.path)) this.#next(key, lane);
  }

  /**
   * An op already in its scope runs another there (Allow's replay): hold and drain the inner
   * op's lanes without entering the owner's scope again, which would wait on itself forever. The
   * owner (the op whose signal is `signal`) may run in a lane the inner op drains (a replace of the
   * canvas it is on): it is neither aborted nor waited for, though what waits behind it is
   * superseded, as for any drain.
   */
  async draining<T>(
    path: readonly string[] | null,
    paths: readonly (readonly string[])[],
    signal: AbortSignal,
    op: () => Promise<T>,
  ): Promise<T> {
    if (paths.length === 0) return op();
    const drain: Drain = { paths, depth: (path?.length ?? 0) + 1 };
    this.#drains.add(drain);
    try {
      await this.#drain(drain, signal);
      signal.throwIfAborted();
      return await op();
    } finally {
      this.#release(drain);
    }
  }

  #lane(key: string, path: readonly string[]): Lane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { path, running: undefined, preempts: [], queue: [], held: 0 };
      this.#lanes.set(key, lane);
    }
    return lane;
  }

  /** What runs in the scope `path` or beneath it. */
  #beneath(path: readonly string[]): Running[] {
    return [...this.#lanes.values()].flatMap(({ running }) =>
      running && path.every((part, i) => running.path[i] === part) ? [running] : [],
    );
  }

  /**
   * Drains the scopes `drain` holds, as a draining op comes: supersedes what waits there, but for
   * preempting ops, and aborts what runs there, but the op draining from within (whose signal is
   * `own`). Resolves once what ran there has ended.
   */
  #drain(drain: Drain, own?: AbortSignal): Promise<void> {
    const running: Running[] = [];
    for (const lane of this.#lanes.values()) {
      if (!holds(drain, lane.path)) continue;
      for (const waiting of lane.queue.splice(0)) waiting.supersede();
      if (lane.running && lane.running.controller.signal !== own) running.push(lane.running);
    }
    return this.#stop(running);
  }

  /**
   * Aborts `ops`, but preempting ones and those past their point of no return, and waits for all
   * of them to end.
   */
  async #stop(ops: readonly Running[]): Promise<void> {
    for (const { preempt, past, controller } of ops) {
      if (!preempt && !past) controller.abort(new Superseded());
    }
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
      const entry: Waiting = {
        start: () => {
          signal?.removeEventListener('abort', gaveUp);
          this.#start(lane, key, path, preempt, signal, op, drained).then(resolve, reject);
        },
        supersede: () => {
          signal?.removeEventListener('abort', gaveUp);
          reject(new Superseded());
        },
      };
      const gaveUp = () => {
        waiting.splice(waiting.indexOf(entry), 1);
        this.#forget(key, lane);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener('abort', gaveUp, { once: true });
      waiting.push(entry);
      this.#next(key, lane);
    });
  }

  /**
   * Starts the next op waiting in a lane that nothing runs in or holds (a preempting op, or a
   * draining op that holds its scope): the first preempting one, else the first queued. Nothing
   * can start in between, so one op at a time runs in the lane.
   */
  #next(key: string, lane: Lane): void {
    if (lane.running || lane.held > 0) return;
    if ([...this.#drains].some((drain) => holds(drain, lane.path))) return;
    const next = lane.preempts.shift() ?? lane.queue.shift();
    if (next) next.start();
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
    const gaveUp = () => {
      if (!running.past) controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', gaveUp, { once: true });
    if (signal?.aborted) gaveUp();
    try {
      if (drained !== undefined) {
        await drained;
        // Superseded, or given up on, while it waited.
        controller.signal.throwIfAborted();
        signal?.throwIfAborted();
      }
      return await op(controller.signal, () => {
        controller.signal.throwIfAborted();
        running.past = true;
      });
    } finally {
      signal?.removeEventListener('abort', gaveUp);
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

/** Whether `drain` holds the scope `path`: one in or beneath what it drains, deep enough. */
function holds(drain: Drain, path: readonly string[]): boolean {
  return (
    path.length >= drain.depth &&
    drain.paths.some((drained) => drained.every((part, i) => path[i] === part))
  );
}
