import type { UsageBackendId } from '../../shared/adapter';
import type { UsageWindows } from '../../shared/usage';
import type { UsageReadings } from '../usage';

/*
 * While a usage backend is held at its hard limit (UsageReadings.exhaust), nothing is delivered to
 * its agents, so no session of it starts to report its usage, and a limit that ends early (the user
 * reset their plan's usage) would hold until the reset the failed turn named. So the core reads a
 * held backend's usage itself, by its adapter's reader, which spends nothing (Adapter.readUsage):
 * as it starts, then every PROBE_MS while the backend is held, one read at a time for each, and
 * takes what it reads (UsageReadings.take), which releases the hold once the exhausted window shows
 * room. A reading that fails, or says nothing, changes nothing: the next is PROBE_MS on. A backend
 * with no reader is held until its reset, as before.
 */

/**
 * How often a held backend is read: a limit that ends early is noticed within it, and a read may
 * start a process of its CLI's own for a moment, so no more often.
 */
export const PROBE_MS = 10 * 60 * 1000;

/** What reads a backend's usage now, spending nothing. */
export type UsageRead = () => Promise<UsageWindows | undefined>;

export interface UsageProbeDeps {
  usage: Pick<UsageReadings, 'exhausted' | 'take'>;
  /** The usage backends the catalog lists. */
  backends: readonly UsageBackendId[];
  /** A backend's reader: undefined for one that has none. */
  readerOf: (backend: UsageBackendId) => UsageRead | undefined;
}

export class UsageProbe {
  readonly #deps: UsageProbeDeps;
  /** The backends being read now. */
  readonly #reading = new Set<UsageBackendId>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(deps: UsageProbeDeps) {
    this.#deps = deps;
  }

  /** Reads every held backend now, and again every PROBE_MS, until stopped. */
  start(): void {
    this.#probe();
  }

  /** Reads no more; what a read under way says is not taken. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #probe(): void {
    if (this.#stopped) return;
    for (const backend of this.#deps.backends) {
      if (this.#reading.has(backend) || this.#deps.usage.exhausted(backend) === undefined) continue;
      const read = this.#deps.readerOf(backend);
      if (read === undefined) continue;
      this.#reading.add(backend);
      void read()
        .then(
          (windows) => {
            if (windows !== undefined && !this.#stopped) this.#deps.usage.take(backend, windows);
          },
          () => undefined,
        )
        .finally(() => {
          this.#reading.delete(backend);
        });
    }
    this.#timer = setTimeout(() => {
      this.#probe();
    }, PROBE_MS);
  }
}
