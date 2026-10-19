import type { UsageBackendId } from '../shared/adapter';
import { parseBackend, parseRule, parseWindows, USAGE_WINDOWS } from '../shared/usage';
import type {
  UsageReading,
  UsageRule,
  UsageState,
  UsageWindow,
  UsageWindows,
} from '../shared/usage';
import { readWhole, unknownFields, writeWhole } from './whole-file';

/*
 * Every backend's latest usage reading, and its usage rule (src/shared/usage.ts). A reading comes
 * from whichever of the backend's agents reports it: `take` is the one way in, so a backend's
 * connection plugs in with one small adapter that turns what its CLI reports into windows (Claude
 * Code's status line: sessions/terminal/statusline.ts; Codex's account/rateLimits). It keeps only
 * the backends the catalog lists (each adapter declares those its connections spend). Readings
 * and rules are remembered across restarts, in a JSON file in the app's user data:
 *
 *   { "version": 2, "readings": [{ "backend", "windows", "at", "simulated"? }],
 *     "rules": { "<backend>": { "window", "percent", "action" } },
 *     "exhausted": { "<backend>": { "resetsAt", "window"? } } }
 *
 * What it holds that this corrallm doesn't know is written back as it was: a newer one's fields (of
 * the file, and of each reading, rule and hard limit it rewrites as it read it: a new one is its
 * own), and the readings, rules and hard limits of backends the catalog doesn't list, unread. A
 * file of another version, or one that isn't JSON, reads as nothing read and no rules, and is set
 * aside (readWhole). One that can't be read is never read as nothing, nor written over: loading
 * rejects, so the core doesn't start without it.
 */

const VERSION = 2;
/** How often listeners hear a reading that has not changed, so that its age stays right. */
const REFRESH_MS = 60_000;
/** How long after a change the file is written: readings come several times a second. */
const WRITE_DELAY_MS = 2000;

/** A hard limit a turn hit, independently of the user's rule. */
interface Exhausted {
  resetsAt: number;
  window?: UsageWindow;
}

export interface UsageReadingsOptions {
  file: string;
  /** The usage backends the catalog lists, in its order: the only ones it keeps. */
  backends: readonly UsageBackendId[];
  now?: () => number;
  writeDelay?: number;
}

export class UsageReadings {
  readonly #file: string;
  readonly #backends: readonly UsageBackendId[];
  readonly #now: () => number;
  readonly #writeDelay: number;
  readonly #readings = new Map<UsageBackendId, UsageReading>();
  readonly #exhausted = new Map<UsageBackendId, Exhausted>();
  #rules: Partial<Record<UsageBackendId, UsageRule>> = {};
  /** What its file holds that this corrallm doesn't know: its fields, and other backends' entries. */
  #unknown: {
    file: Record<string, unknown>;
    readings: unknown[];
    rules: Record<string, unknown>;
    exhausted: Record<string, unknown>;
  } = { file: {}, readings: [], rules: {}, exhausted: {} };
  /** What each reading, rule and hard limit read from its file has that this one doesn't know. */
  readonly #fields = new WeakMap<object, Record<string, unknown>>();
  readonly #listeners = new Set<(state: UsageState, by: 'cli' | 'you') => void>();
  /** When listeners last heard each backend's reading. */
  readonly #told = new Map<UsageBackendId, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor({
    file,
    backends,
    now = Date.now,
    writeDelay = WRITE_DELAY_MS,
  }: UsageReadingsOptions) {
    this.#file = file;
    this.#backends = backends;
    this.#now = now;
    this.#writeDelay = writeDelay;
  }

  /**
   * Reads what was remembered (once, at start); entries that are not right are left out. Rejects if
   * its file can't be read.
   */
  async load(): Promise<void> {
    const file = await readWhole(this.#file, VERSION);
    if (file === undefined) return;
    const now = this.#now();
    const readings = Array.isArray(file.readings) ? (file.readings as unknown[]) : [];
    const rules = isRecord(file.rules) ? file.rules : {};
    const exhausted = isRecord(file.exhausted) ? file.exhausted : {};
    this.#unknown = {
      file: unknownFields(file, ['version', 'readings', 'rules', 'exhausted']),
      readings: readings.filter(
        (value) =>
          isRecord(value) &&
          typeof value.backend === 'string' &&
          !this.#backends.some((backend) => backend === value.backend),
      ),
      rules: unknownFields(rules, this.#backends),
      exhausted: unknownFields(exhausted, this.#backends),
    };
    for (const value of readings) {
      const reading = readingOf(value, this.#backends, now);
      if (!reading) continue;
      this.#readings.set(reading.backend, reading);
      this.#fields.set(reading, unknownFields(value, ['backend', 'windows', 'at', 'simulated']));
    }
    for (const backend of this.#backends) {
      try {
        if (rules[backend] === undefined) continue;
        const rule = parseRule(rules[backend]);
        this.#rules[backend] = rule;
        this.#fields.set(rule, unknownFields(rules[backend], ['window', 'percent', 'action']));
      } catch {
        // Left out.
      }
    }
    for (const backend of this.#backends) {
      const limit = exhausted[backend];
      if (!isRecord(limit) || !future(limit.resetsAt, now)) continue;
      const window = USAGE_WINDOWS.find((name) => name === limit.window);
      const kept = { resetsAt: limit.resetsAt, ...(window === undefined ? {} : { window }) };
      this.#exhausted.set(backend, kept);
      this.#fields.set(kept, unknownFields(limit, ['resetsAt', 'window']));
    }
  }

  /** Every backend's latest reading, and their rules. */
  state(): UsageState {
    return {
      readings: this.#backends.flatMap((backend) => {
        const reading = this.#readings.get(backend);
        return reading ? [reading] : [];
      }),
      rules: { ...this.#rules },
    };
  }

  /** Hears every change; returns a function that stops it. */
  subscribe(listener: (state: UsageState, by: 'cli' | 'you') => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * A failed turn hit the backend's hard limit: held at once, without needing a rule, and told only
   * once the hold is on disk (forced there). Rejects if it can't be written: it holds all the same,
   * but only until the process ends, and no one is told; a later call writes it again.
   */
  async exhaust(backend: UsageBackendId, resetsAt: number): Promise<void> {
    if (!this.#backends.includes(backend) || !future(resetsAt, this.#now())) return;
    const last = this.#exhausted.get(backend);
    if (last === undefined || last.resetsAt < resetsAt) {
      const windows = this.#readings.get(backend)?.windows;
      const window = USAGE_WINDOWS.find((name) => windows?.[name]?.resetsAt === resetsAt);
      this.#exhausted.set(backend, { resetsAt, ...(window === undefined ? {} : { window }) });
    }
    await this.#write(true);
    this.#tell(backend);
  }

  /** Until when a backend is exhausted now, if it is. Expired facts hold nothing. */
  exhausted(backend: UsageBackendId, now = this.#now()): number | undefined {
    const until = this.#exhausted.get(backend)?.resetsAt;
    return until !== undefined && until > now ? until : undefined;
  }

  /**
   * A reading from a backend's CLI (validated: shared/usage.ts parseWindows). Windows it leaves
   * out are kept from the last real reading. The same reading again only says when it was read.
   * A backend the catalog does not list is not kept.
   */
  take(backend: UsageBackendId, windows: UsageWindows): void {
    if (!this.#backends.includes(backend)) return;
    const now = this.#now();
    const last = this.#readings.get(backend);
    const kept = last && !last.simulated ? last.windows : {};
    const reading: UsageReading = { backend, windows: { ...kept, ...windows }, at: now };
    const same =
      last !== undefined && !last.simulated && sameWindows(last.windows, reading.windows);
    this.#readings.set(backend, reading);
    const released = this.#release(backend, windows);
    this.#save();
    if (!released && same && now - (this.#told.get(backend) ?? 0) < REFRESH_MS) return;
    this.#tell(backend);
  }

  /** Sets a simulated reading (`null`: forgets the backend's reading), to try rules with. */
  simulate(backend: UsageBackendId, windows: UsageWindows | null): void {
    if (windows === null) this.#readings.delete(backend);
    else this.#readings.set(backend, { backend, windows, at: this.#now(), simulated: true });
    if (windows !== null) this.#release(backend, windows, true);
    this.#save();
    this.#tell(backend, 'you');
  }

  /** Sets a backend's rule (`null` takes it off). */
  setRule(backend: UsageBackendId, rule: UsageRule | null): void {
    if (rule === null) Reflect.deleteProperty(this.#rules, backend);
    else this.#rules = { ...this.#rules, [backend]: rule };
    this.#save();
    this.#tell(undefined, 'you');
  }

  /** Resolves once everything so far is written: before the app quits. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      void this.#write();
    }
    return this.#writing;
  }

  #tell(backend?: UsageBackendId, by: 'cli' | 'you' = 'cli'): void {
    if (backend !== undefined) this.#told.set(backend, this.#now());
    const state = this.state();
    for (const listener of this.#listeners) listener(state, by);
  }

  #save(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#write();
    }, this.#writeDelay);
  }

  /** Only a new reading of the exhausted window can show room; an omitted window says nothing. */
  #release(backend: UsageBackendId, windows: UsageWindows, simulated = false): boolean {
    const limit = this.#exhausted.get(backend);
    if (!limit) return false;
    const name =
      limit.window ?? USAGE_WINDOWS.find((name) => windows[name]?.resetsAt === limit.resetsAt);
    if (name !== undefined) limit.window = name;
    const seen =
      name === undefined
        ? simulated
          ? Object.values(windows)
          : []
        : [windows[name]].filter((window) => window !== undefined);
    if (
      seen.length === 0 ||
      seen.some(
        ({ usedPercent, resetsAt }) =>
          usedPercent >= 100 && (resetsAt === null || resetsAt > this.#now()),
      )
    )
      return false;
    this.#exhausted.delete(backend);
    void this.#write();
    return true;
  }

  /** `entry` with what it had that this corrallm doesn't know, if it is one read from its file. */
  #withFields<T extends object>(entry: T): T {
    return { ...this.#fields.get(entry), ...entry };
  }

  /**
   * Writes what it keeps, after every write before it. A failed write is logged, as for readings
   * and rules; a `durable` one (a hold's) rejects instead, for its caller to say.
   */
  #write(durable = false): Promise<void> {
    const { readings, rules } = this.state();
    const exhausted = [...this.#exhausted].filter(([, limit]) => limit.resetsAt > this.#now());
    const unknown = this.#unknown;
    const file = {
      version: VERSION,
      ...unknown.file,
      readings: [...readings.map((reading) => this.#withFields(reading)), ...unknown.readings],
      rules: {
        ...unknown.rules,
        ...Object.fromEntries(
          Object.entries(rules).flatMap(([backend, rule]) =>
            rule === undefined ? [] : [[backend, this.#withFields(rule)]],
          ),
        ),
      },
      exhausted: {
        ...unknown.exhausted,
        ...Object.fromEntries(
          exhausted.map(([backend, limit]) => [backend, this.#withFields(limit)]),
        ),
      },
    };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    const write = this.#writing.then(() => writeWhole(this.#file, text, { durable }));
    this.#writing = write.catch((error: unknown) => {
      if (!durable) console.error('Could not remember usage readings:', error);
    });
    return durable ? write : this.#writing;
  }
}

function future(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > now;
}

/** A remembered reading of one of `backends`, or undefined if it is not right. */
function readingOf(
  value: unknown,
  backends: readonly UsageBackendId[],
  now: number,
): UsageReading | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const backend = parseBackend(value.backend, backends);
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
