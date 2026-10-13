import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import {
  parseBackend,
  parseRule,
  parseWindows,
  USAGE_BACKENDS,
  USAGE_WINDOWS,
} from '../shared/usage';
import type {
  UsageBackend,
  UsageReading,
  UsageRule,
  UsageState,
  UsageWindows,
} from '../shared/usage';

/*
 * Every backend's latest usage reading, and its usage rule (src/shared/usage.ts). A reading comes
 * from whichever of the backend's agents reports it: `take` is the one way in, so a backend's
 * connection plugs in with one small adapter that turns what its CLI reports into windows (Claude
 * Code's status line: sessions/terminal/statusline.ts; Codex's account/rateLimits, later).
 * Readings and rules are remembered across restarts, in a JSON file in the app's user data:
 *
 *   { "version": 1, "readings": [{ "backend", "windows", "at", "simulated"? }],
 *     "rules": { "<backend>": { "window", "percent", "action" } } }
 */

const VERSION = 1;
/** How often listeners hear a reading that has not changed, so that its age stays right. */
const REFRESH_MS = 60_000;
/** How long after a change the file is written: readings come several times a second. */
const WRITE_DELAY_MS = 2000;

export interface UsageReadingsOptions {
  file: string;
  now?: () => number;
  writeDelay?: number;
}

export class UsageReadings {
  readonly #file: string;
  readonly #now: () => number;
  readonly #writeDelay: number;
  readonly #readings = new Map<UsageBackend, UsageReading>();
  #rules: Partial<Record<UsageBackend, UsageRule>> = {};
  readonly #listeners = new Set<(state: UsageState) => void>();
  /** When listeners last heard each backend's reading. */
  readonly #told = new Map<UsageBackend, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor({ file, now = Date.now, writeDelay = WRITE_DELAY_MS }: UsageReadingsOptions) {
    this.#file = file;
    this.#now = now;
    this.#writeDelay = writeDelay;
  }

  /** Reads what was remembered (once, at start); entries that are not right are left out. */
  async load(): Promise<void> {
    let file: unknown;
    try {
      file = JSON.parse(await readFile(this.#file, 'utf8'));
    } catch {
      return;
    }
    if (!isRecord(file) || file.version !== VERSION) return;
    const now = this.#now();
    for (const value of Array.isArray(file.readings) ? (file.readings as unknown[]) : []) {
      const reading = readingOf(value, now);
      if (reading) this.#readings.set(reading.backend, reading);
    }
    const rules = isRecord(file.rules) ? file.rules : {};
    for (const backend of USAGE_BACKENDS) {
      try {
        if (rules[backend] !== undefined) this.#rules[backend] = parseRule(rules[backend]);
      } catch {
        // Left out.
      }
    }
  }

  /** Every backend's latest reading, and their rules. */
  state(): UsageState {
    return {
      readings: USAGE_BACKENDS.flatMap((backend) => {
        const reading = this.#readings.get(backend);
        return reading ? [reading] : [];
      }),
      rules: { ...this.#rules },
    };
  }

  /** Hears every change; returns a function that stops it. */
  subscribe(listener: (state: UsageState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * A reading from a backend's CLI (validated: shared/usage.ts parseWindows). Windows it leaves
   * out are kept from the last real reading. The same reading again only says when it was read.
   */
  take(backend: UsageBackend, windows: UsageWindows): void {
    const now = this.#now();
    const last = this.#readings.get(backend);
    const kept = last && !last.simulated ? last.windows : {};
    const reading: UsageReading = { backend, windows: { ...kept, ...windows }, at: now };
    const same =
      last !== undefined && !last.simulated && sameWindows(last.windows, reading.windows);
    this.#readings.set(backend, reading);
    this.#save();
    if (same && now - (this.#told.get(backend) ?? 0) < REFRESH_MS) return;
    this.#tell(backend);
  }

  /** Sets a simulated reading (`null`: forgets the backend's reading), to try rules with. */
  simulate(backend: UsageBackend, windows: UsageWindows | null): void {
    if (windows === null) this.#readings.delete(backend);
    else this.#readings.set(backend, { backend, windows, at: this.#now(), simulated: true });
    this.#save();
    this.#tell(backend);
  }

  /** Sets a backend's rule (`null` takes it off). */
  setRule(backend: UsageBackend, rule: UsageRule | null): void {
    if (rule === null) Reflect.deleteProperty(this.#rules, backend);
    else this.#rules = { ...this.#rules, [backend]: rule };
    this.#save();
    this.#tell();
  }

  /** Resolves once everything so far is written: before the app quits. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#write();
    }
    return this.#writing;
  }

  #tell(backend?: UsageBackend): void {
    if (backend !== undefined) this.#told.set(backend, this.#now());
    const state = this.state();
    for (const listener of this.#listeners) listener(state);
  }

  #save(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#write();
    }, this.#writeDelay);
  }

  #write(): void {
    const { readings, rules } = this.state();
    const text = `${JSON.stringify({ version: VERSION, readings, rules }, null, 2)}\n`;
    const partial = `${this.#file}.${String(process.pid)}.partial`;
    // A failed write is logged: readings are a convenience, never worth failing for.
    this.#writing = this.#writing
      .then(async () => {
        try {
          await writeFile(partial, text, 'utf8');
          await rename(partial, this.#file);
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
      })
      .catch((error: unknown) => {
        console.error('Could not remember usage readings:', error);
      });
  }
}

/** A remembered reading, or undefined if it is not right. */
function readingOf(value: unknown, now: number): UsageReading | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const backend = parseBackend(value.backend);
    const windows = parseWindows(value.windows, now);
    const { at } = value;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return undefined;
    return { backend, windows, at, ...(value.simulated === true ? { simulated: true } : {}) };
  } catch {
    return undefined;
  }
}

function sameWindows(a: UsageWindows, b: UsageWindows): boolean {
  return USAGE_WINDOWS.every((window) => {
    const x = a[window];
    const y = b[window];
    return x === y || (x?.usedPercent === y?.usedPercent && x?.resetsAt === y?.resetsAt);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
