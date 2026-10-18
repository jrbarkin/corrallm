import { readFile } from 'node:fs/promises';

import { writeWhole } from './memory';
import type { PlanConsent } from './sessions/codex/login';

/** What the user chose for corrallm as a whole, rather than for one canvas (memory.ts). */
export interface AppSettings {
  /**
   * Codex's App Server connection may run on the user's ChatGPT plan without asking each session:
   * they said "don't ask again" (sessions/codex/login.ts).
   */
  chatgptPlan?: true;
}

const VERSION = 1;

/**
 * The user's settings for the app, kept between runs in a JSON file in the app's user data:
 *
 *   { "version": 1, "settings": { "chatgptPlan"?: true } }
 *
 * Updates are applied one at a time, in order, and written whole.
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

  update(change: (settings: AppSettings) => AppSettings): Promise<void> {
    const run = async () => {
      const next = change(await this.#load());
      this.#settings = Promise.resolve(next);
      await writeWhole(
        this.#file,
        `${JSON.stringify({ version: VERSION, settings: next }, null, 2)}\n`,
      );
    };
    // A failed write is logged: the setting holds for this run.
    this.#writing = this.#writing.then(run).catch((error: unknown) => {
      console.error('Could not keep the settings:', error);
    });
    return this.#writing;
  }

  /** Resolves once every update so far is written: before the app quits. */
  flush(): Promise<void> {
    return this.#writing;
  }

  #load(): Promise<AppSettings> {
    this.#settings ??= readFile(this.#file, 'utf8').then(parse, () => ({}));
    return this.#settings;
  }
}

/** Whether Codex's app server may run on the user's ChatGPT plan without asking, as `settings` keep it. */
export function planConsent(settings: Settings): PlanConsent {
  return {
    given: async () => (await settings.get()).chatgptPlan === true,
    give: () => settings.update((s) => ({ ...s, chatgptPlan: true })),
  };
}

/** The settings a settings file holds; those that are not right are left out. */
function parse(text: string): AppSettings {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(file) || file.version !== VERSION || !isRecord(file.settings)) return {};
  return file.settings.chatgptPlan === true ? { chatgptPlan: true } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
