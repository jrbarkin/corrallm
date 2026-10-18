import { readFile } from 'node:fs/promises';

import { writeWhole } from './memory';

/** What the user chose for corrallm as a whole, rather than for one canvas (memory.ts). */
export interface AppSettings {
  /**
   * What the user allowed for good ("don't ask again"), by adapter and then by the key its adapter
   * asks it by (connectors.ts), so that adapter no longer asks each session.
   */
  consents: Readonly<Record<string, Readonly<Record<string, true>>>>;
}

/** A consent only the user gives: whether they gave it for good, and giving it. */
export interface Consent {
  given(): Promise<boolean>;
  give(): Promise<void>;
}

const VERSION = 2;
/** What names an adapter, or a consent's key: never a key an object has of its own. */
const KEY = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;

/**
 * The user's settings for the app, kept between runs in a JSON file in the app's user data:
 *
 *   { "version": 2, "consents": { "<adapter>": { "<key>": true } } }
 *
 * Updates are applied one at a time, in order, and written whole. A file of another version reads
 * as nothing chosen.
 */
export class Settings {
  readonly #file: string;
  #settings: Promise<AppSettings> | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async get(): Promise<AppSettings> {
    await this.#writing;
    return this.#load();
  }

  /** The consent `adapter` asks the user for by `key`, as these settings keep it. */
  consent(adapter: string, key: string): Consent {
    return {
      given: async () => (await this.get()).consents[adapter]?.[key] === true,
      give: () =>
        this.#update((settings) => ({
          ...settings,
          consents: {
            ...settings.consents,
            [adapter]: { ...settings.consents[adapter], [key]: true },
          },
        })),
    };
  }

  /** Resolves once every update so far is written: before the app quits. */
  flush(): Promise<void> {
    return this.#writing;
  }

  #update(change: (settings: AppSettings) => AppSettings): Promise<void> {
    const run = async () => {
      const next = change(await this.#load());
      this.#settings = Promise.resolve(next);
      await writeWhole(this.#file, `${JSON.stringify({ version: VERSION, ...next }, null, 2)}\n`);
    };
    // A failed write is logged: the setting holds for this run.
    this.#writing = this.#writing.then(run).catch((error: unknown) => {
      console.error('Could not keep the settings:', error);
    });
    return this.#writing;
  }

  #load(): Promise<AppSettings> {
    this.#settings ??= readFile(this.#file, 'utf8').then(parse, () => ({ consents: {} }));
    return this.#settings;
  }
}

/** The settings a settings file holds; those that are not right are left out. */
function parse(text: string): AppSettings {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return { consents: {} };
  }
  if (!isRecord(file) || file.version !== VERSION) return { consents: {} };
  const consents = isRecord(file.consents) ? file.consents : {};
  return {
    consents: Object.fromEntries(
      Object.entries(consents).flatMap(([adapter, given]) => {
        if (!KEY.test(adapter) || !isRecord(given)) return [];
        const keys = Object.keys(given).filter((key) => KEY.test(key) && given[key] === true);
        return keys.length === 0
          ? []
          : [[adapter, Object.fromEntries(keys.map((key) => [key, true]))]];
      }),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
