import { ID_PATTERN } from '../shared/adapter';
import type { AdapterId } from '../shared/adapter';
import { readWhole, unknownFields, writeWhole } from './whole-file';

/** What the user chose for corrallm as a whole, rather than for one canvas (memory.ts). */
export interface AppSettings {
  /**
   * What the user allowed for good ("don't ask again"), by adapter and then by the key its adapter
   * asks it by (connectors.ts), so that adapter no longer asks each session.
   */
  consents: Readonly<Record<string, Readonly<Record<string, true>>>>;
  /**
   * The API server's own settings: the port it listens on, chosen free once and kept, so that what
   * orchestrators registered it by survives restarts (API Spec §8.1).
   */
  api?: { port: number };
  /**
   * Whether corrallm shows OS notifications (B14 C11): absent, or not a boolean, means on. Read by
   * the core at each event; B22a's setter writes it, yours alone. Never in the token-readable
   * `settings.get`.
   */
  notifications?: { enabled: boolean };
  /**
   * The agent corrallm adds when you add one (B12 C2), or null to be asked each time: yours alone
   * to set (`settings.set`). Kept as it was saved, even an id this build's catalog lacks, which
   * the window treats as none. Nothing in the core reads it to create or run an agent.
   */
  defaultAdapter: AdapterId | null;
}

/**
 * A consent only the user gives: whether they gave it for good, and giving it. Its generation
 * moves each time you take it back (B22a C4), so a grant made at an older one holds no more: a
 * session's "Yes, for this session", or an Always answered to a question asked before.
 */
export interface Consent {
  /** Its generation now, read at once: moved by each successful `resetConsent`. */
  generation(): number;
  given(): Promise<boolean>;
  /** Keeps it for good, unless it was taken back since `generation` (then nothing is kept). */
  give(generation: number): Promise<void>;
}

/** Why a setting is as it was: its file couldn't be read, or couldn't be written. */
export class SettingsFailure extends Error {
  readonly stage: 'read' | 'write';

  constructor(stage: 'read' | 'write', cause: unknown) {
    super(`Could not ${stage} the settings.`, { cause });
    this.name = 'SettingsFailure';
    this.stage = stage;
  }
}

const VERSION = 2;

/**
 * The user's settings for the app, kept between runs in a JSON file in the app's user data:
 *
 *   { "version": 2, "consents": { "<adapter>": { "<key>": true } }, "api"?: { "port" },
 *     "notifications"?: { "enabled" }, "defaultAdapter"?: "<id>" }
 *
 * Updates are applied one at a time, in order, and written whole, with what it holds that this
 * corrallm doesn't know (a newer one's fields, of the file and of `api`) written back as it was. A
 * file of another version, or one that isn't JSON, reads as nothing chosen and is set aside
 * (readWhole); one that can't be read fails what needed it, and is read again next time.
 * `defaultAdapter` is absent for none, and text without an id's shape reads as none.
 */
export class Settings {
  readonly #file: string;
  #settings: Promise<AppSettings> | undefined;
  /** What its file holds that this corrallm doesn't know: of the file, `api` and `notifications`. */
  #unknown: {
    file: Record<string, unknown>;
    api: Record<string, unknown>;
    notifications: Record<string, unknown>;
  } = { file: {}, api: {}, notifications: {} };
  #writing: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();
  /**
   * Each consent's generation (B22a C4), by adapter and key, for this run: moved each time it is
   * taken back, absent (0) until it is. A new run needs none: every session that held one ended.
   */
  readonly #generations = new Map<string, number>();

  constructor(file: string) {
    this.#file = file;
  }

  async get(): Promise<AppSettings> {
    await this.#writing;
    return this.#load();
  }

  /** Hears each update to the settings kept for this run. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The consent `adapter` asks the user for by `key`, as these settings keep it. Giving it keeps
   * the historical log-and-continue (`#update`), checked against its generation in the same lane
   * as a reset, so a grant queued after one, answered before it, keeps nothing.
   */
  consent(adapter: string, key: string): Consent {
    const id = consentId(adapter, key);
    const generation = () => this.#generations.get(id) ?? 0;
    return {
      generation,
      given: async () => (await this.get()).consents[adapter]?.[key] === true,
      give: (at) =>
        this.#update((settings) =>
          generation() !== at
            ? settings
            : {
                ...settings,
                consents: {
                  ...settings.consents,
                  [adapter]: { ...settings.consents[adapter], [key]: true },
                },
              },
        ),
    };
  }

  /**
   * Takes back the consent `adapter` asks for by `key` (B22a C4, C6), strictly: from the latest
   * settings, written gone first if kept, then its generation moved, so no grant made before holds
   * (a session's own included), then told to listeners if the file changed. `declared`: its adapter
   * declares it, so a live session may hold it with nothing kept, and it moves even then. True if
   * anything changed; false for an undeclared one not kept, which changes nothing. Rejects with a
   * SettingsFailure, nothing changed, when the file can't be read or written.
   */
  resetConsent(adapter: string, key: string, declared: boolean): Promise<boolean> {
    return this.#strictly((current) => {
      const kept = current.consents[adapter]?.[key] === true;
      if (!kept && !declared) return { result: false };
      const then = () => {
        const id = consentId(adapter, key);
        this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1);
      };
      if (!kept) return { result: true, then };
      const rest = Object.fromEntries(
        Object.entries(current.consents[adapter] ?? {}).filter(([one]) => one !== key),
      );
      const others = Object.fromEntries(
        Object.entries(current.consents).filter(([one]) => one !== adapter),
      );
      // The adapter's last key takes the adapter with it; the others keep their order.
      const consents =
        Object.keys(rest).length === 0 ? others : { ...current.consents, [adapter]: rest };
      return { next: { ...current, consents }, result: true, then };
    });
  }

  /** The port the API server listens on, if one was kept. */
  async apiPort(): Promise<number | undefined> {
    return (await this.get()).api?.port;
  }

  /** Keeps the port the API server listens on, for the next time it starts. */
  keepApiPort(port: number): Promise<void> {
    return this.#update((settings) => ({ ...settings, api: { port } }));
  }

  /**
   * Whether OS notifications are on (B14 C11): unless the file says `enabled: false`, they are,
   * whether the field is absent, not a boolean, or the file can't be read.
   */
  async notificationsEnabled(): Promise<boolean> {
    try {
      return (await this.get()).notifications?.enabled !== false;
    } catch {
      return true;
    }
  }

  /** The agent corrallm adds when you add one, or null to be asked each time (B12 C2). */
  async defaultAdapter(): Promise<AdapterId | null> {
    return (await this.get()).defaultAdapter;
  }

  /**
   * Sets the default agent (B12 C2): written first, then held and told to listeners. True once
   * written; false when it was already so, writing nothing and telling no one. Rejects with a
   * SettingsFailure saying which, memory, file and listeners as they were, when the file can't be
   * read or written; later updates still run. (A consent keeps `#update`'s log-and-continue.)
   */
  setDefaultAdapter(id: AdapterId | null): Promise<boolean> {
    return this.#strictly((current) =>
      current.defaultAdapter === id
        ? { result: false }
        : { next: { ...current, defaultAdapter: id }, result: true },
    );
  }

  /**
   * Turns OS notifications on or off (B22a C1, C6), as `setDefaultAdapter` sets the default:
   * written first, then held and told; false, writing nothing, when they already are (absent, or
   * not a boolean, is on). What a newer corrallm keeps beside `enabled` is written back as it was.
   */
  setNotifications(enabled: boolean): Promise<boolean> {
    return this.#strictly((current) =>
      (current.notifications?.enabled !== false) === enabled
        ? { result: false }
        : { next: { ...current, notifications: { enabled } }, result: true },
    );
  }

  /** Resolves once every update so far is written: before the app quits. */
  flush(): Promise<void> {
    return this.#writing;
  }

  /** The file's text for `next`, with what this corrallm doesn't know written back as it was. */
  #text(next: AppSettings): string {
    const { file, api, notifications } = this.#unknown;
    const { defaultAdapter, ...kept } = next;
    const text = JSON.stringify(
      {
        version: VERSION,
        ...file,
        ...kept,
        ...(next.api === undefined && Object.keys(api).length === 0
          ? {}
          : { api: { ...api, ...next.api } }),
        ...(next.notifications === undefined && Object.keys(notifications).length === 0
          ? {}
          : { notifications: { ...notifications, ...next.notifications } }),
        ...(defaultAdapter === null ? {} : { defaultAdapter }),
      },
      null,
      2,
    );
    return `${text}\n`;
  }

  /**
   * A strict update (B12 C2, B22a C6), in the one lane, from the latest settings: `decide` says
   * what they become (`next`, none to write nothing), what the caller is told, and what follows
   * once it is written (`then`, before listeners hear). Read or write failing rejects with a
   * SettingsFailure saying which, memory, file and listeners as they were; later updates run.
   */
  #strictly<T>(
    decide: (current: AppSettings) => { next?: AppSettings; result: T; then?: () => void },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      let current: AppSettings;
      try {
        current = await this.#load();
      } catch (error) {
        throw new SettingsFailure('read', error);
      }
      const { next, result, then } = decide(current);
      if (next !== undefined) {
        try {
          await writeWhole(this.#file, this.#text(next));
        } catch (error) {
          throw new SettingsFailure('write', error);
        }
        this.#settings = Promise.resolve(next);
      }
      then?.();
      if (next !== undefined) for (const listener of this.#listeners) listener();
      return result;
    };
    const result = this.#writing.then(run);
    this.#writing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** A log-and-continue update: one that changes nothing (a stale grant) writes nothing. */
  #update(change: (settings: AppSettings) => AppSettings): Promise<void> {
    let changed = true;
    const run = async () => {
      const current = await this.#load();
      const next = change(current);
      changed = next !== current;
      if (!changed) return;
      this.#settings = Promise.resolve(next);
      await writeWhole(this.#file, this.#text(next));
    };
    // A failed write is logged: the setting holds for this run.
    this.#writing = this.#writing
      .then(run)
      .catch((error: unknown) => {
        console.error('Could not keep the settings:', error);
      })
      .then(() => {
        if (changed) for (const listener of this.#listeners) listener();
      });
    return this.#writing;
  }

  #load(): Promise<AppSettings> {
    this.#settings ??= readWhole(this.#file, VERSION).then(
      (file) => {
        this.#unknown = {
          file: unknownFields(file, [
            'version',
            'consents',
            'api',
            'notifications',
            'defaultAdapter',
          ]),
          api: unknownFields(
            file?.api,
            isRecord(file?.api) && isPort(file.api.port) ? ['port'] : [],
          ),
          notifications: unknownFields(
            file?.notifications,
            isRecord(file?.notifications) && typeof file.notifications.enabled === 'boolean'
              ? ['enabled']
              : [],
          ),
        };
        return parse(file);
      },
      (error: unknown) => {
        // Never read as nothing chosen, nor written over: read again next time.
        this.#settings = undefined;
        throw error;
      },
    );
    return this.#settings;
  }
}

/** The settings a settings file holds (none if there is none); those not right are left out. */
function parse(file: Record<string, unknown> | undefined): AppSettings {
  const consents = isRecord(file?.consents) ? file.consents : {};
  const port = isRecord(file?.api) ? file.api.port : undefined;
  const enabled = isRecord(file?.notifications) ? file.notifications.enabled : undefined;
  const chosen = file?.defaultAdapter;
  return {
    ...(isPort(port) ? { api: { port } } : {}),
    ...(typeof enabled === 'boolean' ? { notifications: { enabled } } : {}),
    defaultAdapter: typeof chosen === 'string' && ID_PATTERN.test(chosen) ? chosen : null,
    consents: Object.fromEntries(
      Object.entries(consents).flatMap(([adapter, given]) => {
        if (!ID_PATTERN.test(adapter) || !isRecord(given)) return [];
        // A consent's key has an id's shape too: never a key an object has of its own.
        const keys = Object.keys(given).filter(
          (key) => ID_PATTERN.test(key) && given[key] === true,
        );
        return keys.length === 0
          ? []
          : [[adapter, Object.fromEntries(keys.map((key) => [key, true]))]];
      }),
    ),
  };
}

/** A consent's key in the generations: its adapter's and its own, which neither contains. */
function consentId(adapter: string, key: string): string {
  return `${adapter}\u0000${key}`;
}

/** Whether a value is a port a server may listen on. */
function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
