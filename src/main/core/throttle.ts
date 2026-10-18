import { TOKEN_IN_FLIGHT, TOKEN_WRITES_PER_SECOND } from '../../shared/api/limits';

/*
 * The limits per token (Core Server §6.7): at most TOKEN_IN_FLIGHT calls in flight and
 * TOKEN_WRITES_PER_SECOND writes in any second, so a runaway or hijacked client can't load the
 * core. core.call admits each token's call here; you are never limited.
 */

export class Throttle {
  readonly #now: () => number;
  readonly #inFlight = new Map<string, number>();
  /** When each key's writes of the last second came. */
  readonly #writes = new Map<string, number[]>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /**
   * Admits a call by `key` (a write if `write`): a function to call once it is done, or undefined
   * if it is over a limit and refused.
   */
  admit(key: string, write: boolean): (() => void) | undefined {
    const inFlight = this.#inFlight.get(key) ?? 0;
    if (inFlight >= TOKEN_IN_FLIGHT) return undefined;
    if (write) {
      const now = this.#now();
      const recent = (this.#writes.get(key) ?? []).filter((at) => now - at < 1000);
      if (recent.length >= TOKEN_WRITES_PER_SECOND) return undefined;
      recent.push(now);
      this.#writes.set(key, recent);
    }
    this.#inFlight.set(key, inFlight + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#inFlight.get(key) ?? 1) - 1;
      if (left > 0) this.#inFlight.set(key, left);
      else this.#inFlight.delete(key);
    };
  }
}
