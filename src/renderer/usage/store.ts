import { NO_USAGE } from '../../shared/usage';
import type { UsageBackendId } from '../../shared/adapter';
import type { UsageReading, UsageRule, UsageState, UsageWindows } from '../../shared/usage';
import { ipcErrorMessage } from '../ipc-error';

/** The core's usage topic mirror and the operations that set rules or simulate readings. */
export interface UsageSource {
  topics: {
    snapshot: (topic: 'usage') => UsageState | undefined;
    subscribe: (topic: 'usage', listener: () => void) => () => void;
  };
  setRule: (backend: UsageBackendId, rule: UsageRule | null) => Promise<unknown>;
  simulate: (backend: UsageBackendId, windows: UsageWindows | null) => Promise<unknown>;
}

/**
 * Every backend's usage reading and rule, as the core keeps them (one per backend, for every canvas),
 * for the gauges and the run (useSyncExternalStore). Rules are set and readings simulated through
 * the core, which pushes its usage topic. Without a source (as in tests), it keeps them
 * itself.
 */
export class UsageStore {
  #state: UsageState = NO_USAGE;
  readonly #listeners = new Set<() => void>();
  readonly #source: UsageSource | undefined;
  readonly #now: () => number;
  readonly #stop: (() => void) | undefined;

  constructor(source?: UsageSource, now: () => number = Date.now) {
    this.#source = source;
    this.#now = now;
    if (!source) return;
    this.#state = source.topics.snapshot('usage') ?? NO_USAGE;
    this.#stop = source.topics.subscribe('usage', () => {
      this.#set(source.topics.snapshot('usage') ?? NO_USAGE);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every backend's reading and rule: a new object after each change. */
  snapshot = (): UsageState => this.#state;

  /** Sets a backend's usage rule, or (null) takes it off. */
  setRule(backend: UsageBackendId, rule: UsageRule | null): void {
    if (this.#source) {
      this.#source.setRule(backend, rule).catch((error: unknown) => {
        console.error('Could not set the usage rule:', ipcErrorMessage(error));
      });
      return;
    }
    const rules = { ...this.#state.rules };
    if (rule === null) Reflect.deleteProperty(rules, backend);
    else rules[backend] = rule;
    this.#set({ ...this.#state, rules });
  }

  /** Simulates a backend's usage, or (null) forgets its reading. */
  simulate(backend: UsageBackendId, windows: UsageWindows | null): void {
    if (this.#source) {
      this.#source.simulate(backend, windows).catch((error: unknown) => {
        console.error('Could not simulate usage:', ipcErrorMessage(error));
      });
      return;
    }
    const others = this.#state.readings.filter((reading) => reading.backend !== backend);
    const simulated: UsageReading[] =
      windows === null ? [] : [{ backend, windows, at: this.#now(), simulated: true }];
    this.#set({ ...this.#state, readings: [...others, ...simulated] });
  }

  /** Stops observing the topic mirror. */
  dispose(): void {
    this.#stop?.();
  }

  #set(state: UsageState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
