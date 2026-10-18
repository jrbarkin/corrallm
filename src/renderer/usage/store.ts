import { NO_USAGE } from '../../shared/usage';
import type { UsageBackendId } from '../../shared/adapter';
import type { UsageReading, UsageRule, UsageState, UsageWindows } from '../../shared/usage';
import { ipcErrorMessage } from '../ipc-error';

/** Main's usage readings and rules (window.api's usage functions; src/main/usage.ts). */
export interface UsageSource {
  get: () => Promise<UsageState>;
  setRule: (backend: UsageBackendId, rule: UsageRule | null) => Promise<null>;
  simulate: (backend: UsageBackendId, windows: UsageWindows | null) => Promise<null>;
  onChanged: (listener: (state: UsageState) => void) => () => void;
}

/**
 * Every backend's usage reading and rule, as main keeps them (one per backend, for every canvas),
 * for the gauges and the run (useSyncExternalStore). Rules are set and readings simulated through
 * main, which tells every renderer the change. Without main (`source`, as in tests), it keeps them
 * itself.
 */
export class UsageStore {
  #state: UsageState = NO_USAGE;
  readonly #listeners = new Set<() => void>();
  readonly #source: UsageSource | undefined;
  readonly #now: () => number;
  readonly #stop: (() => void) | undefined;
  /** Whether main has told a change, which is newer than what it was asked for at the start. */
  #told = false;

  constructor(source?: UsageSource, now: () => number = Date.now) {
    this.#source = source;
    this.#now = now;
    if (!source) return;
    this.#stop = source.onChanged((state) => {
      this.#told = true;
      this.#set(state);
    });
    source.get().then(
      (state) => {
        if (!this.#told) this.#set(state);
      },
      (error: unknown) => {
        console.error('Could not read usage:', ipcErrorMessage(error));
      },
    );
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

  /** Stops hearing main. */
  dispose(): void {
    this.#stop?.();
  }

  #set(state: UsageState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
