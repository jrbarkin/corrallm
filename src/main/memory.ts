import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import { isSessionId } from './sessions/id';

/**
 * What main remembers of a canvas file: its project folder, and its agents' sessions' ids (Claude
 * Code's sessions, Codex's threads). What its agents are set to run with (their models, efforts and
 * modes) is in the canvas's file itself.
 */
export interface Remembered {
  project?: string;
  /** The id of each agent's Claude Code session, by agent id: resumed when the agent starts. */
  sessions: Readonly<Record<string, string>>;
  /** The id of each agent's Codex thread (Codex's sessions), by agent id, likewise. */
  threads?: Readonly<Record<string, string>>;
}

const NOTHING: Remembered = { sessions: {} };
/** How many canvases it remembers: the ones used most recently. */
const LIMIT = 200;
const VERSION = 1;

/**
 * What main remembers of each canvas file between runs, by the file's path, in a JSON file in the
 * app's user data. The canvas file itself only holds what the canvas means (src/renderer/graph/
 * file.ts), so it can be shared: where it runs on this machine is kept here.
 *
 *   { "version": 1, "canvases": { "<canvas path>": { "project"?, "sessions": { "<agent>": id },
 *       "threads"?: { "<agent>": id } } } }
 *
 * Updates are applied one at a time, in order, and written whole (beside it, then moved over it).
 */
export class CanvasMemory {
  readonly #file: string;
  readonly #limit: number;
  #canvases: Promise<Map<string, Remembered>> | undefined;
  #writing: Promise<void> = Promise.resolve();
  #writeError: Error | undefined;

  constructor(file: string, limit = LIMIT) {
    this.#file = file;
    this.#limit = limit;
  }

  async get(canvas: string): Promise<Remembered> {
    return (await this.#load()).get(canvas) ?? NOTHING;
  }

  /**
   * Changes what it remembers of `canvas`, which becomes the canvas used most recently.
   * `known` distinguishes an intentionally empty record from one absent from memory.
   */
  update(
    canvas: string,
    change: (remembered: Remembered, known: boolean) => Remembered,
  ): Promise<void> {
    const run = async () => {
      const canvases = await this.#load();
      const next = change(canvases.get(canvas) ?? NOTHING, canvases.has(canvas));
      canvases.delete(canvas);
      canvases.set(canvas, next);
      for (const oldest of canvases.keys()) {
        if (canvases.size <= this.#limit) break;
        canvases.delete(oldest);
      }
      await this.#write(canvases);
      this.#writeError = undefined;
    };
    // Ordinary metadata updates remain nonfatal, but shutdown must not lose native resume IDs.
    this.#writing = this.#writing.then(run).catch((error: unknown) => {
      this.#writeError = error instanceof Error ? error : new Error(String(error));
      console.error('Could not remember the canvas:', error);
    });
    return this.#writing;
  }

  /** Resolves once every update so far is written; rejects a still-unrecovered write failure. */
  async flush(): Promise<void> {
    await this.#writing;
    if (this.#writeError !== undefined) throw this.#writeError;
  }

  #load(): Promise<Map<string, Remembered>> {
    this.#canvases ??= readFile(this.#file, 'utf8').then(parse, () => new Map());
    return this.#canvases;
  }

  async #write(canvases: Map<string, Remembered>): Promise<void> {
    await writeWhole(
      this.#file,
      `${JSON.stringify({ version: VERSION, canvases: Object.fromEntries(canvases) }, null, 2)}\n`,
    );
  }
}

/** Writes a file whole: beside it, then moved over it, so it is never left half written. */
export async function writeWhole(file: string, text: string): Promise<void> {
  const partial = `${file}.${String(process.pid)}.partial`;
  try {
    await writeFile(partial, text, 'utf8');
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** The canvases a memory file holds; entries that are not right are left out. */
function parse(text: string): Map<string, Remembered> {
  const canvases = new Map<string, Remembered>();
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return canvases;
  }
  if (!isRecord(file) || file.version !== VERSION || !isRecord(file.canvases)) return canvases;
  for (const [canvas, value] of Object.entries(file.canvases)) {
    if (!isRecord(value)) continue;
    const { project, sessions, threads } = value;
    if (project !== undefined && typeof project !== 'string') continue;
    canvases.set(canvas, {
      ...(project === undefined ? {} : { project }),
      sessions: ids(sessions),
      ...(isRecord(threads) ? { threads: ids(threads) } : {}),
    });
  }
  return canvases;
}

/** The ids in a record of them, by agent; values that are not ids are left out. */
function ids(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter((entry): entry is [string, string] =>
      isSessionId(entry[1]),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
