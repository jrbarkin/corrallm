import { TOKEN_IN_FLIGHT, TOKEN_WAITS, TOKEN_WRITES_PER_SECOND } from '../../shared/api/limits';

/*
 * The limits per token (Core Server §6.7), kept by `callerKey` (an outside token's id; for one of
 * corrallm's agents the logical agent, across its sessions' generations): at most TOKEN_IN_FLIGHT
 * calls in flight and TOKEN_WRITES_PER_SECOND writes in any second, so a runaway or hijacked
 * client can't load the core. A call that waits for what comes (a long poll, `wait`) counts apart, against TOKEN_WAITS:
 * a token waiting on each of its workers still makes its other calls. core.call admits each
 * token's call here; you are never limited.
 */

/** What a call is, as the limits count it. */
export interface Admitted {
  /** It writes: it counts against the writes a second. */
  write: boolean;
  /** It waits for what comes: it counts against the waits in flight, not the calls. */
  waits: boolean;
}

export class Throttle {
  readonly #now: () => number;
  readonly #inFlight = new Map<string, number>();
  readonly #waiting = new Map<string, number>();
  /** When each key's writes of the last second came. */
  readonly #writes = new Map<string, number[]>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /**
   * Admits a call by `key`: a function to call once it is done, or the limit it is over and was
   * refused for.
   */
  admit(key: string, { write, waits }: Admitted): (() => void) | 'calls' | 'waits' {
    const counts = waits ? this.#waiting : this.#inFlight;
    const inFlight = counts.get(key) ?? 0;
    if (inFlight >= (waits ? TOKEN_WAITS : TOKEN_IN_FLIGHT)) return waits ? 'waits' : 'calls';
    if (write) {
      const now = this.#now();
      const recent = (this.#writes.get(key) ?? []).filter((at) => now - at < 1000);
      if (recent.length >= TOKEN_WRITES_PER_SECOND) return 'calls';
      recent.push(now);
      this.#writes.set(key, recent);
    }
    counts.set(key, inFlight + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (counts.get(key) ?? 1) - 1;
      if (left > 0) counts.set(key, left);
      else counts.delete(key);
    };
  }
}
