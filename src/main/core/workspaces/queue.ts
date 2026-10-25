/*
 * The provisioning queue (B9a Design §2, Git execution boundary): Git work that changes a
 * repository runs one job at a time per repository, keyed by its canonical common Git directory
 * (shared by every canvas, and by B9b's merges), with at most `concurrency` repositories at work at
 * once, and at most `capacity` jobs waiting or running: past it, a job is refused, not queued, so
 * the queue never grows without bound. Work in it never waits for a person or an agent's turn.
 */

/** The queue holds as many jobs as it may: try again once some are done. */
export class QueueFull extends Error {
  constructor() {
    super('Too many workspaces are being made at once.');
    this.name = 'QueueFull';
  }
}

export class ProvisioningQueue {
  readonly #concurrency: number;
  readonly #capacity: number;
  /** Each repository's last job: the next one starts after it. */
  readonly #lanes = new Map<string, Promise<unknown>>();
  /** Jobs waiting for one of the slots of work. */
  readonly #waiting: (() => void)[] = [];
  #running = 0;
  #size = 0;

  constructor({
    concurrency = 2,
    capacity = 64,
  }: { concurrency?: number; capacity?: number } = {}) {
    this.#concurrency = concurrency;
    this.#capacity = capacity;
  }

  /** Jobs waiting or running. */
  get size(): number {
    return this.#size;
  }

  /** Whether a job would be refused now. */
  get full(): boolean {
    return this.#size >= this.#capacity;
  }

  /** Runs `work` after the jobs queued before it for the same repository (`key`). */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.full) return Promise.reject(new QueueFull());
    this.#size += 1;
    const before = this.#lanes.get(key) ?? Promise.resolve();
    // Counted until it settles, before its caller hears.
    const start = () =>
      this.#slot(work).finally(() => {
        this.#size -= 1;
      });
    const done = before.then(start, start);
    const lane = done.catch(() => undefined);
    this.#lanes.set(key, lane);
    void lane.then(() => {
      if (this.#lanes.get(key) === lane) this.#lanes.delete(key);
    });
    return done;
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#concurrency) {
      const turn = Promise.withResolvers<undefined>();
      this.#waiting.push(() => {
        turn.resolve(undefined);
      });
      await turn.promise;
    } else this.#running += 1;
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      // The slot passes straight to the next job waiting, else it is free.
      if (next) next();
      else this.#running -= 1;
    }
  }
}
