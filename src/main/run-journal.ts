import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { isCanvasId, newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { MAX_CANVAS_BYTES } from '../shared/ipc';
import { MAX_RUN_BYTES, parseRunCheckpoint } from '../shared/run';
import type { RunCheckpoint, RunContext } from '../shared/run';
import { mintTrustedPath } from './core/host';
import type { TrustedPath } from './core/host';
import { readRemembered, writeWhole } from './memory';
import type { CanvasMemory, Remembered } from './memory';

/** What the journal keeps of a canvas a window shows: its generation's token, and what to say. */
interface Entry {
  token: string;
  warning?: string;
}
/** A canvas's run record, as written (runs/<id>/record.json). */
interface RecordFile {
  checkpoint: RunCheckpoint;
  /** The canvas's file, and what memory has of it besides: recovered if memory lost it. */
  file?: TrustedPath;
  remembered?: Remembered;
}
interface JournalDeps {
  memory: CanvasMemory;
  projectOf(canvas: CanvasId): string | undefined;
}

const VERSION = 2;
const MISSING = 'The saved canvas is missing. Its run was restored as an unsaved canvas.';

/**
 * Each canvas's run, journaled atomically by the canvas's id, its messages, and the canvas the
 * profile had open last:
 *
 *   runs/<canvas id>/record.json     { "version": 2, "id", "file"?, "checkpoint", "remembered"? }
 *   runs/<canvas id>/messages.jsonl  the canvas's message store's log, appended (a line a change)
 *   runs/last.json                   { "version": 2, "canvas" }
 *
 * Every write goes through one queue, in order: a message's record appended durably (forced to
 * disk) is on disk before anything journaled after it.
 *
 * A record names the canvas's file and keeps a copy of what memory has of it, which comes back if
 * canvas memory lost it. A window's renderer saves with the token of the canvas it showed: a save
 * meant for a canvas it has since replaced (or opened again) is refused. A record that can't be
 * read as one is set aside, saying where; a last canvas of another version reads as none.
 */
export class RunJournal {
  readonly #directory: string;
  readonly #deps: JournalDeps;
  readonly #entries = new Map<CanvasId, Entry>();
  #writing: Promise<void> = Promise.resolve();

  constructor(directory: string, deps: JournalDeps) {
    this.#directory = directory;
    this.#deps = deps;
  }

  /**
   * The canvas the profile had open last, its memory recovered from its record if it lost it: a new
   * draft if there is none. Rejects, keeping it, if what says which it was can't be read.
   */
  async last(): Promise<CanvasId> {
    let last: unknown;
    try {
      last = JSON.parse(await readFile(this.#lastFile(), 'utf8'));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const canvas = isLast(last) ? last.canvas : newCanvasId();
    const record = await this.#read(canvas, this.#entry(canvas));
    if (record !== undefined) {
      const { file, remembered } = record;
      // A present memory is authoritative, including conversations cleared by a project change or
      // a rewind: the record only recovers a canvas memory lost.
      await this.#deps.memory.update(canvas, (current, known) =>
        known ? current : { ...(remembered ?? { conversations: {} }), ...(file ? { file } : {}) },
      );
    }
    await this.#serialize(() => this.#last(canvas));
    return canvas;
  }

  /** What a window showing `canvas` restores: its run, its file's name and text, its folder. */
  async get(canvas: CanvasId): Promise<RunContext> {
    await this.flush();
    const entry = this.#entry(canvas);
    const record = await this.#read(canvas, entry);
    const { file } = await this.#deps.memory.get(canvas);
    let savedText: string | undefined;
    if (file !== undefined) {
      try {
        savedText = await canvasText(file);
      } catch (error) {
        if (!missing(error)) throw error;
        // Its file is gone: it goes on unsaved, as the same canvas.
        entry.warning = [entry.warning, MISSING].filter(Boolean).join(' ');
        await this.#deps.memory.setFile(canvas, undefined);
      }
    }
    const folder = this.#deps.projectOf(canvas);
    return {
      id: canvas,
      token: entry.token,
      checkpoint: record?.checkpoint ?? null,
      name: file === undefined || savedText === undefined ? null : path.basename(file),
      ...(folder === undefined ? {} : { project: { name: path.basename(folder), path: folder } }),
      ...(savedText === undefined ? {} : { savedText }),
      ...(entry.warning === undefined ? {} : { warning: entry.warning }),
    };
  }

  /** Journals a canvas's run (null: none), for the renderer whose token is its canvas's. */
  async save(canvas: CanvasId, token: string, checkpoint: RunCheckpoint | null): Promise<void> {
    const entry = this.#entry(canvas);
    if (entry.token !== token) throw new Error('This run belongs to an earlier canvas');
    if (checkpoint !== null) {
      parseRunCheckpoint(checkpoint);
      if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_RUN_BYTES) {
        throw new RangeError('The run checkpoint is too large');
      }
    }
    return this.#serialize(async () => {
      if (this.#entries.get(canvas) !== entry || entry.token !== token) {
        throw new Error('This run belongs to an earlier canvas');
      }
      if (checkpoint === null) await rm(this.#recordFile(canvas), { force: true });
      else await this.#write(canvas, checkpoint);
      await this.#last(canvas);
    });
  }

  /**
   * A window opened `canvas` (saying `warning` once, as why it opened as a copy): a new generation,
   * so the renderer's earlier token no longer saves.
   */
  async opened(canvas: CanvasId, warning?: string): Promise<void> {
    this.#entries.set(canvas, { token: randomUUID(), ...(warning ? { warning } : {}) });
    await this.#serialize(() => this.#last(canvas));
  }

  /** New: a new draft, its id. The canvas before keeps its record. */
  async draft(): Promise<CanvasId> {
    const canvas = newCanvasId();
    this.#entries.set(canvas, { token: randomUUID() });
    await this.#serialize(() => this.#last(canvas));
    return canvas;
  }

  /** A canvas was saved (Save As too, which keeps its id): its record names its file now. */
  async saved(canvas: CanvasId): Promise<void> {
    const record = await this.#read(canvas, this.#entry(canvas));
    await this.#serialize(async () => {
      if (record !== undefined) await this.#write(canvas, record.checkpoint);
      await this.#last(canvas);
    });
  }

  flush(): Promise<void> {
    return this.#writing;
  }

  /** The canvas's message log, as written: undefined if it has none yet. */
  async readMessages(canvas: CanvasId): Promise<string | undefined> {
    await this.flush();
    try {
      return await readFile(this.#messagesFile(canvas), 'utf8');
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  /**
   * Appends `text` to the canvas's message log, after whatever was journaled before it; with
   * `durable`, forced to disk (the log and all appended before it) before it resolves.
   */
  appendMessages(canvas: CanvasId, text: string, durable: boolean): Promise<void> {
    return this.#serialize(async () => {
      const file = this.#messagesFile(canvas);
      await mkdir(path.dirname(file), { recursive: true });
      const handle = await open(file, 'a');
      try {
        if (text !== '') await handle.appendFile(text, 'utf8');
        if (durable) await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /** Writes the canvas's message log anew, whole, as `text`: what its store keeps now. */
  rewriteMessages(canvas: CanvasId, text: string): Promise<void> {
    return this.#serialize(async () => {
      const file = this.#messagesFile(canvas);
      await mkdir(path.dirname(file), { recursive: true });
      await writeWhole(file, text);
    });
  }

  /** Sets the canvas's message log aside, as one that can't be read: where it is now. */
  async setAsideMessages(canvas: CanvasId): Promise<string> {
    const file = this.#messagesFile(canvas);
    const rejected = file.replace(/\.jsonl$/, `.rejected-${randomUUID()}.jsonl`);
    await this.#serialize(() => rename(file, rejected));
    return rejected;
  }

  #entry(canvas: CanvasId): Entry {
    let entry = this.#entries.get(canvas);
    if (entry === undefined) {
      entry = { token: randomUUID() };
      this.#entries.set(canvas, entry);
    }
    return entry;
  }

  #recordFile(canvas: CanvasId): string {
    return path.join(this.#directory, canvas, 'record.json');
  }

  #messagesFile(canvas: CanvasId): string {
    return path.join(this.#directory, canvas, 'messages.jsonl');
  }

  #lastFile(): string {
    return path.join(this.#directory, 'last.json');
  }

  async #read(canvas: CanvasId, entry: Entry): Promise<RecordFile | undefined> {
    const file = this.#recordFile(canvas);
    let text: string | undefined;
    try {
      if ((await stat(file)).size <= MAX_RUN_BYTES * 2) text = await readFile(file, 'utf8');
    } catch (error) {
      // A read that fails (not a record that is wrong) may work next time: it is not set aside.
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      if (text === undefined) throw new Error('The saved run is too large');
      const value: unknown = JSON.parse(text);
      if (!isRecord(value) || value.version !== VERSION || value.id !== canvas) {
        throw new Error('The saved run is invalid');
      }
      if (value.file !== undefined && !isAbsolute(value.file)) {
        throw new Error('The saved run is invalid');
      }
      const remembered = readRemembered(value.remembered);
      return {
        checkpoint: parseRunCheckpoint(value.checkpoint),
        ...(value.file === undefined ? {} : { file: mintTrustedPath(value.file) }),
        ...(remembered === undefined ? {} : { remembered }),
      };
    } catch {
      const rejected = file.replace(/\.json$/, `.rejected-${randomUUID()}.json`);
      await rename(file, rejected);
      entry.warning = `The run progress could not be restored and its record was moved to ${rejected}.`;
      return undefined;
    }
  }

  async #write(canvas: CanvasId, checkpoint: RunCheckpoint): Promise<void> {
    const { file, ...remembered } = await this.#deps.memory.get(canvas);
    await mkdir(path.dirname(this.#recordFile(canvas)), { recursive: true });
    await writeWhole(
      this.#recordFile(canvas),
      JSON.stringify({
        version: VERSION,
        id: canvas,
        ...(file === undefined ? {} : { file }),
        checkpoint,
        remembered,
      }),
    );
  }

  async #last(canvas: CanvasId): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    let rejected = false;
    try {
      JSON.parse(await readFile(this.#lastFile(), 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) rejected = true;
      else if (!missing(error)) throw error;
    }
    if (rejected) {
      await copyFile(
        this.#lastFile(),
        path.join(this.#directory, `last.rejected-${randomUUID()}.json`),
      );
    }
    await writeWhole(this.#lastFile(), JSON.stringify({ version: VERSION, canvas }));
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const writing = this.#writing.then(operation);
    this.#writing = writing.catch(() => undefined);
    return writing;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}
function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
async function canvasText(file: string): Promise<string> {
  if ((await stat(file)).size > MAX_CANVAS_BYTES) throw new Error('The saved canvas is too large');
  return readFile(file, 'utf8');
}
/** What says which canvas was open last: of this version, else none. */
function isLast(value: unknown): value is { version: 2; canvas: CanvasId } {
  return isRecord(value) && value.version === VERSION && isCanvasId(value.canvas);
}
