import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { isCanvasId, newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { MAX_CANVAS_BYTES } from '../shared/ipc';
import type { PartyId } from '../shared/model/messages';
import { MAX_RUN_BYTES, parseRunCheckpoint } from '../shared/run';
import type { RunCheckpoint, RunContext } from '../shared/run';
import { mintTrustedPath } from './core/host';
import type { TrustedPath } from './core/host';
import type { Database } from './core/store/store';
import type { CanvasMemory } from './memory';
import { writeWhole } from './whole-file';

/** What the journal keeps of a canvas a window shows: its generation's token, and what to say. */
interface Entry {
  token: string;
  warning?: string;
}
/**
 * Where each party has read to in a canvas's message store, by party: the place of the last message
 * its `wait` returned (API Spec §7.7).
 */
export type KeptReads = Readonly<Record<string, number>>;
/** A party's read position moved forward to `seq`, as a `wait` moves it. */
export interface MovedRead {
  party: PartyId;
  seq: number;
}
/** A run as its row keeps it. */
interface Run {
  /** The run's state: the checkpoint's version, state and messages, as one JSON object. */
  state: string;
  workflow: string;
  /** The workflow's SHA-256, by which a save tells whether it changed. */
  hash: string;
  updatedAt: number;
}
interface JournalDeps {
  /** The profile's database, which keeps the runs, where parties have read to, and the last canvas. */
  store: Database;
  /** What the canvases' rows are kept by. */
  memory: CanvasMemory;
  projectOf(canvas: CanvasId): string | undefined;
  /** What opening the database found to say (core/store/open.ts): said with the first run restored. */
  said?: readonly string[];
}

/** How the journal makes its folders: only the user may list or enter them. */
const PRIVATE = { recursive: true, mode: 0o700 } as const;
const MISSING = 'The saved canvas is missing. Its run was restored as an unsaved canvas.';
const EARLIER = 'This run belongs to an earlier canvas';

/**
 * Each canvas's run, journaled by the canvas's id in the profile's database (Core Database §5),
 * where each party's `wait` has read to in its messages, and the canvas the profile had open last:
 *
 *   run            the run's state, and the workflow it runs, written only when its hash changes
 *   read_position  each party's read position in the canvas's messages
 *   open_canvas    the canvas the profile had open last: a window that shows none restores it
 *
 * and, until the database keeps messages too, each canvas's message log in its folder:
 *
 *   runs/<canvas id>/messages.jsonl  the canvas's message store's log, appended (a line a change)
 *
 * Every write goes through one queue, in order: one is on disk (the commit that holds it returned,
 * or the log forced to disk) before anything journaled after it, so that a run's record is on disk
 * before the message it sends, and a kill's hold before what it takes back. Saves keep the read
 * positions as they were (the app's never moves one), but the save that moves one forward, which
 * is on disk once it resolves. A window's renderer saves with the token of the canvas it showed: a
 * save meant for a canvas it has since replaced (or opened again) is refused. A run that can't be
 * restored as one is discarded, saying so. The canvas's file is read back with its run, as canvas
 * memory wrote it, from the app's dialogs. The folders it makes are the user's alone.
 */
export class RunJournal {
  readonly #directory: string;
  readonly #deps: JournalDeps;
  readonly #entries = new Map<CanvasId, Entry>();
  /** Each canvas's workflow's hash, as its run's row has it, once read or written. */
  readonly #workflows = new Map<CanvasId, string>();
  /** What opening the database found to say, until the first run restored says it. */
  #said: string | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(directory: string, deps: JournalDeps) {
    this.#directory = directory;
    this.#deps = deps;
    this.#said =
      deps.said === undefined || deps.said.length === 0 ? undefined : deps.said.join(' ');
  }

  /**
   * The canvas the profile had open last: a new draft if there is none. Rejects if what says which
   * it was can't be read.
   */
  async last(): Promise<CanvasId> {
    await this.flush();
    const id = this.#deps.store
      .prepare('SELECT canvas_id FROM open_canvas ORDER BY opened_at DESC LIMIT 1')
      .get()?.canvas_id;
    const canvas = isCanvasId(id) ? id : newCanvasId();
    await this.#write(() => {
      this.#markOpen(canvas);
    });
    return canvas;
  }

  /** What a window showing `canvas` restores: its run, its file's name and text, its folder. */
  async get(canvas: CanvasId): Promise<RunContext> {
    await this.flush();
    const entry = this.#entry(canvas);
    const row = this.#deps.store
      .prepare(
        `SELECT c.file AS file, r.canvas_id AS ran, json_extract(r.state, '$.version') AS version,
           json_extract(r.state, '$.state') AS state, json_extract(r.state, '$.messages') AS messages,
           r.workflow AS workflow, r.updated_at AS updated_at
         FROM canvas c LEFT JOIN run r ON r.canvas_id = c.id WHERE c.id = ?`,
      )
      .get(canvas);
    if (this.#said !== undefined) {
      entry.warning = [this.#said, entry.warning].filter(Boolean).join(' ');
      this.#said = undefined;
    }
    let checkpoint: RunCheckpoint | null = null;
    if (typeof row?.ran === 'string') {
      try {
        checkpoint = parseRunCheckpoint({
          version: row.version,
          workflow: row.workflow,
          state: row.state,
          messages: row.messages,
          updatedAt: row.updated_at,
        });
        this.#workflows.set(canvas, sha256(checkpoint.workflow));
      } catch (error) {
        // Deleted, so that it is neither read nor said again.
        await this.#write(() => {
          this.#deps.store.prepare('DELETE FROM run WHERE canvas_id = ?').run(canvas);
        });
        this.#workflows.delete(canvas);
        const why = error instanceof Error ? error.message : String(error);
        entry.warning = [
          entry.warning,
          `The run progress could not be restored, so it was discarded (${why}).`,
        ]
          .filter(Boolean)
          .join(' ');
      }
    }
    const kept = row?.file;
    const file = isAbsolute(kept) ? mintTrustedPath(kept) : undefined;
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
      checkpoint,
      name: file === undefined || savedText === undefined ? null : path.basename(file),
      ...(folder === undefined ? {} : { project: { name: path.basename(folder), path: folder } }),
      ...(savedText === undefined ? {} : { savedText }),
      ...(entry.warning === undefined ? {} : { warning: entry.warning }),
    };
  }

  /** Where each party's `wait` has read to in the canvas's messages. */
  async reads(canvas: CanvasId): Promise<KeptReads> {
    await this.flush();
    const rows = this.#deps.store
      .prepare('SELECT party, seq FROM read_position WHERE canvas_id = ?')
      .all(canvas);
    return Object.fromEntries(rows.map(({ party, seq }) => [String(party), Number(seq)]));
  }

  /**
   * Journals a canvas's run (null: none), for the renderer whose token is its canvas's, keeping
   * where each party's `wait` has read to; with `moved`, that party's moved forward (never back).
   * On disk once it resolves.
   */
  async save(
    canvas: CanvasId,
    token: string,
    checkpoint: RunCheckpoint | null,
    moved?: MovedRead,
  ): Promise<void> {
    const entry = this.#entry(canvas);
    if (entry.token !== token) throw new Error(EARLIER);
    let run: Run | undefined;
    if (checkpoint !== null) {
      const { version, workflow, state, messages, updatedAt } = parseRunCheckpoint(checkpoint);
      if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_RUN_BYTES) {
        throw new RangeError('The run checkpoint is too large');
      }
      // Its state and messages are JSON texts (parseRunCheckpoint read them): kept as they are.
      run = {
        state: `{"version":${String(version)},"state":${state},"messages":${messages}}`,
        workflow,
        hash: sha256(workflow),
        updatedAt,
      };
    }
    try {
      await this.#write(() => {
        if (this.#entries.get(canvas) !== entry || entry.token !== token) {
          throw new Error(EARLIER);
        }
        this.#deps.memory.ensure(canvas);
        if (run === undefined) {
          this.#deps.store.prepare('DELETE FROM run WHERE canvas_id = ?').run(canvas);
        } else this.#keepRun(canvas, run);
        if (moved !== undefined) {
          this.#deps.store
            .prepare(
              `INSERT INTO read_position (canvas_id, party, seq) VALUES (?, ?, ?)
               ON CONFLICT (canvas_id, party) DO UPDATE SET seq = max(seq, excluded.seq)`,
            )
            .run(canvas, moved.party, moved.seq);
        }
        this.#markOpen(canvas);
      });
    } catch (error) {
      // What the row has now isn't known: the next save writes its workflow.
      this.#workflows.delete(canvas);
      throw error;
    }
    if (run === undefined) this.#workflows.delete(canvas);
    else this.#workflows.set(canvas, run.hash);
  }

  /**
   * A window opened `canvas` (saying `warning` once, as why it opened as a copy): a new generation,
   * so the renderer's earlier token no longer saves.
   */
  async opened(canvas: CanvasId, warning?: string): Promise<void> {
    this.#entries.set(canvas, { token: randomUUID(), ...(warning ? { warning } : {}) });
    await this.#write(() => {
      this.#markOpen(canvas);
    });
  }

  /** New: a new draft, its id. The canvas before keeps its run. */
  async draft(): Promise<CanvasId> {
    const canvas = newCanvasId();
    this.#entries.set(canvas, { token: randomUUID() });
    await this.#write(() => {
      this.#markOpen(canvas);
    });
    return canvas;
  }

  /** A canvas was saved (Save As too, which keeps its id): it is the one the profile has open. */
  async saved(canvas: CanvasId): Promise<void> {
    await this.#write(() => {
      this.#markOpen(canvas);
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
      await mkdir(path.dirname(file), PRIVATE);
      const handle = await open(file, 'a');
      try {
        if (text !== '') await handle.appendFile(text, 'utf8');
        if (durable) await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Writes the canvas's message log anew, whole, as `text`: what its store keeps now, forced to
   * disk (the log before it is moved into place, its folder after) before it resolves, so that no
   * power loss brings the old log back over what is appended to the new one.
   */
  rewriteMessages(canvas: CanvasId, text: string): Promise<void> {
    return this.#serialize(async () => {
      const file = this.#messagesFile(canvas);
      await mkdir(path.dirname(file), PRIVATE);
      await writeWhole(file, text, { durable: true });
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

  #messagesFile(canvas: CanvasId): string {
    return path.join(this.#directory, canvas, 'messages.jsonl');
  }

  /** Writes to the database, in the journal's queue: resolves once the commit holding it returned. */
  #write(write: () => void): Promise<void> {
    return this.#serialize(() => this.#deps.store.write(write));
  }

  /**
   * Within a write: the canvas's run, its workflow written only if it changed since the row was
   * last read or written (else only its state), and the whole row if the canvas has none.
   */
  #keepRun(canvas: CanvasId, { state, workflow, hash, updatedAt }: Run): void {
    const { store } = this.#deps;
    if (this.#workflows.get(canvas) === hash) {
      const kept = store
        .prepare('UPDATE run SET state = ?, updated_at = ? WHERE canvas_id = ?')
        .run(state, updatedAt, canvas);
      if (kept.changes > 0) return;
    }
    store
      .prepare(
        `INSERT INTO run (canvas_id, state, workflow, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET
           state = excluded.state, workflow = excluded.workflow, updated_at = excluded.updated_at`,
      )
      .run(canvas, state, workflow, updatedAt);
  }

  /** Within a write: `canvas` is the one the profile has open now, and the only one. */
  #markOpen(canvas: CanvasId): void {
    const { store, memory } = this.#deps;
    memory.ensure(canvas);
    store.prepare('DELETE FROM open_canvas WHERE canvas_id <> ?').run(canvas);
    store
      .prepare(
        `INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET opened_at = excluded.opened_at`,
      )
      .run(canvas, Date.now());
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const writing = this.#writing.then(operation);
    this.#writing = writing.catch(() => undefined);
    return writing;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
async function canvasText(file: TrustedPath): Promise<string> {
  if ((await stat(file)).size > MAX_CANVAS_BYTES) throw new Error('The saved canvas is too large');
  return readFile(file, 'utf8');
}
