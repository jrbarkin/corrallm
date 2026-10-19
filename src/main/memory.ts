import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ID_PATTERN } from '../shared/adapter';
import { isCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { mintTrustedPath } from './core/host';
import type { TrustedPath } from './core/host';
import { isSessionId } from './sessions/id';

/** A native conversation an agent runs in a CLI: its id, and the role it launched with. */
export interface Conversation {
  id: string;
  /**
   * The role's fingerprint as the conversation launched with it (roleFingerprint). Absent when it
   * is not known (one picked with /resume, or a rewind's copy): a changed role, once.
   */
  role?: string;
}

/**
 * What main remembers of a canvas: the file it was opened from or saved to (none for a draft),
 * the folder its agents work in, and its agents' conversations, by adapter and then by agent
 * (each CLI's: the one every connection of it resumes). What its agents are set to run with (their
 * models, efforts, modes and role text) is in the canvas's file itself.
 */
export interface Remembered {
  file?: TrustedPath;
  project?: TrustedPath;
  conversations: Readonly<Record<string, Readonly<Record<string, Conversation>>>>;
}

/** The role a conversation launched with, without keeping its text; 'none' means no role. */
export function roleFingerprint(role: string | undefined): string {
  return role === undefined ? 'none' : createHash('sha256').update(role).digest('hex');
}

const NOTHING: Remembered = { conversations: {} };
/** How many canvases it remembers: the ones used most recently. */
const LIMIT = 200;
const VERSION = 2;

/**
 * What main remembers of each canvas between runs, by the canvas's id, in a JSON file in the app's
 * user data. The canvas file itself only holds what the canvas means (src/shared/model/file.ts),
 * so it can be shared: where it is and where it runs on this machine is kept here.
 *
 *   { "version": 2, "canvases": { "<canvas id>": { "file"?, "project"?,
 *       "conversations": { "<adapter>": { "<agent>": { "id", "role"? } } } } } }
 *
 * A file belongs to one canvas at most. Updates are applied one at a time, in order, and written
 * whole (beside it, then moved over it). The paths it reads back are trusted: it wrote them, from
 * the app's dialogs. A file of another version, or one that isn't JSON, reads as empty and is set
 * aside (readWhole); one that can't be read fails what needed it, and is read again next time.
 */
export class CanvasMemory {
  readonly #file: string;
  readonly #limit: number;
  #canvases: Promise<Map<CanvasId, Remembered>> | undefined;
  #writing: Promise<void> = Promise.resolve();
  #writeError: Error | undefined;

  constructor(file: string, limit = LIMIT) {
    this.#file = file;
    this.#limit = limit;
  }

  /** What it remembers of a canvas, with every update asked for so far. */
  async get(canvas: CanvasId): Promise<Remembered> {
    await this.#writing;
    return (await this.#load()).get(canvas) ?? NOTHING;
  }

  /** The canvas whose file `file` is, if any. */
  async canvasWithFile(file: string): Promise<CanvasId | undefined> {
    await this.#writing;
    for (const [canvas, remembered] of await this.#load()) {
      if (remembered.file === file) return canvas;
    }
    return undefined;
  }

  /**
   * Changes what it remembers of `canvas`, which becomes the canvas used most recently.
   * `known` distinguishes an intentionally empty record from one absent from memory.
   */
  update(
    canvas: CanvasId,
    change: (remembered: Remembered, known: boolean) => Remembered,
  ): Promise<void> {
    return this.#change((canvases) => {
      const next = change(canvases.get(canvas) ?? NOTHING, canvases.has(canvas));
      canvases.delete(canvas);
      canvases.set(canvas, next);
    });
  }

  /**
   * Sets the file a canvas is opened from and saved to (undefined: none, a draft's). Another canvas
   * that had that file has it no more.
   */
  setFile(canvas: CanvasId, file: TrustedPath | undefined): Promise<void> {
    return this.#change((canvases) => {
      for (const [other, remembered] of canvases) {
        if (other !== canvas && file !== undefined && remembered.file === file) {
          canvases.set(other, withFile(remembered, undefined));
        }
      }
      const next = withFile(canvases.get(canvas) ?? NOTHING, file);
      canvases.delete(canvas);
      canvases.set(canvas, next);
    });
  }

  /** Resolves once every update so far is written; rejects a still-unrecovered write failure. */
  async flush(): Promise<void> {
    await this.#writing;
    if (this.#writeError !== undefined) throw this.#writeError;
  }

  #change(apply: (canvases: Map<CanvasId, Remembered>) => void): Promise<void> {
    const run = async () => {
      const canvases = await this.#load();
      apply(canvases);
      for (const oldest of canvases.keys()) {
        if (canvases.size <= this.#limit) break;
        canvases.delete(oldest);
      }
      await this.#write(canvases);
      this.#writeError = undefined;
    };
    // Ordinary updates remain nonfatal, but shutdown must not lose native resume IDs.
    this.#writing = this.#writing.then(run).catch((error: unknown) => {
      this.#writeError = error instanceof Error ? error : new Error(String(error));
      console.error('Could not remember the canvas:', error);
    });
    return this.#writing;
  }

  #load(): Promise<Map<CanvasId, Remembered>> {
    this.#canvases ??= readWhole(this.#file, VERSION).then(parse, (error: unknown) => {
      // Never read as empty, nor written over: read again next time.
      this.#canvases = undefined;
      throw error;
    });
    return this.#canvases;
  }

  async #write(canvases: Map<CanvasId, Remembered>): Promise<void> {
    await writeWhole(
      this.#file,
      `${JSON.stringify({ version: VERSION, canvases: Object.fromEntries(canvases) }, null, 2)}\n`,
    );
  }
}

/** `remembered` with its file set (undefined: none). */
function withFile(remembered: Remembered, file: TrustedPath | undefined): Remembered {
  const next = { ...remembered };
  if (file === undefined) delete next.file;
  else next.file = file;
  return next;
}

/** How writeWhole writes a file. */
export interface WriteOptions {
  /** The file's permissions (0o600: only the user may read it), else the process's default. */
  mode?: number;
  /**
   * Forced to disk: the file beside it before it is moved over it, and its folder after, so not
   * even the machine stopping loses it once it is written.
   */
  durable?: boolean;
}

/**
 * Writes a file whole: beside it, then moved over it, so it is never left half written. Each write
 * has its own file beside it, so writes of the same file at once never move each other's.
 */
export async function writeWhole(
  file: string,
  text: string,
  { mode, durable = false }: WriteOptions = {},
): Promise<void> {
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    if (durable) {
      const handle = await open(partial, 'w', mode);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await writeFile(partial, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    }
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  if (durable) await syncFolder(path.dirname(file));
}

/**
 * Reads a store's file, written whole: its JSON object, if it is one of `version`; undefined if
 * there is no file. A file that isn't one (not JSON, not an object, another version: an older
 * corrallm's included) is set aside beside it, as `<name>.rejected-<uuid>.json`, saying where, and
 * reads as none, so that what it held is never written over. Rejects, leaving the file as it is,
 * if it is there but can't be read (its permissions, the disk, too many files open): it may hold
 * what is still good, so it is never read as none, and the store reads it again when next asked.
 */
export async function readWhole(
  file: string,
  version: number,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Set aside below.
  }
  if (isRecord(value) && value.version === version) return value;
  let why = 'it isn’t a JSON object';
  if (isRecord(value)) {
    why =
      value.version === undefined
        ? 'it has no version'
        : `it is of version ${JSON.stringify(value.version)}, not ${String(version)}`;
  }
  const rejected = path.join(
    path.dirname(file),
    `${path.basename(file, '.json')}.rejected-${randomUUID()}.json`,
  );
  await rename(file, rejected);
  console.error(`Could not read ${file} (${why}), so it was moved to ${rejected}.`);
  return undefined;
}

/** Whether a file can't be read because there is none: missing, or a folder on its path a file. */
function absent(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Forces a folder's entries to disk: a file just moved into it. Windows opens no folder to. */
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(folder, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The canvases a memory file holds (none if there is none); entries not right are left out. */
function parse(file: Record<string, unknown> | undefined): Map<CanvasId, Remembered> {
  const canvases = new Map<CanvasId, Remembered>();
  if (!isRecord(file?.canvases)) return canvases;
  for (const [canvas, value] of Object.entries(file.canvases)) {
    const remembered = readRemembered(value);
    if (isCanvasId(canvas) && remembered !== undefined) canvases.set(canvas, remembered);
  }
  return canvases;
}

/**
 * What is remembered of a canvas, as written (in canvases.json, or a run record's copy of it):
 * undefined if it is not right. Conversations whose ids are not ids are left out, and role
 * fingerprints that are not fingerprints.
 */
export function readRemembered(value: unknown): Remembered | undefined {
  if (!isRecord(value)) return undefined;
  const { file, project, conversations } = value;
  if (file !== undefined && !isAbsolute(file)) return undefined;
  if (project !== undefined && !isAbsolute(project)) return undefined;
  return {
    ...(file === undefined ? {} : { file: mintTrustedPath(file) }),
    ...(project === undefined ? {} : { project: mintTrustedPath(project) }),
    conversations: Object.fromEntries(
      Object.entries(isRecord(conversations) ? conversations : {}).flatMap(([adapter, agents]) =>
        ID_PATTERN.test(adapter) && isRecord(agents) ? [[adapter, readConversations(agents)]] : [],
      ),
    ),
  };
}

/** An adapter's agents' conversations; those that are not right are left out. */
function readConversations(agents: Record<string, unknown>): Record<string, Conversation> {
  return Object.fromEntries(
    Object.entries(agents).flatMap(([agent, value]) => {
      if (!isRecord(value) || !isSessionId(value.id)) return [];
      const { role } = value;
      const known = typeof role === 'string' && (role === 'none' || /^[a-f0-9]{64}$/.test(role));
      return [[agent, { id: value.id, ...(known ? { role } : {}) }]];
    }),
  );
}

function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
