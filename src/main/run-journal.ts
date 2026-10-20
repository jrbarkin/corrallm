import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
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
interface JournalDeps {
  /** The profile's database, which keeps the runs, where parties have read to, and the last canvas. */
  store: Database;
  /** What the canvases' rows are kept by. */
  memory: CanvasMemory;
  projectOf(canvas: CanvasId): string | undefined;
  /** What opening the database found to say (core/store/open.ts): said with the first run restored. */
  said?: readonly string[];
}

const MISSING = 'The saved canvas is missing. Its run was restored as an unsaved canvas.';
const EARLIER = 'This run belongs to an earlier canvas';

/**
 * Each canvas's run, journaled by the canvas's id in the profile's database (Core Database §5),
 * where each party's `wait` has read to in its messages, and the canvas the profile had open last:
 *
 *   run            the run's state (the document it runs is the core's: core/canvas/documents.ts)
 *   read_position  each party's read position in the canvas's messages
 *   open_canvas    the canvas the profile had open last: a window that shows none restores it
 *
 * Its writes go through the database's write lane, in order, each on the drive once it resolves
 * (the commit that holds it returned and the log was flushed); the core's canvases journal their
 * runs within writes of their own (`keep`, `moveRead`), with what else commits with them (their
 * messages; every position a `wait` moves). A save keeps the read positions as they are: only a `wait` moves one, and only
 * forward. A window's renderer saves with the token of the canvas it showed: a save meant for a
 * canvas it has since replaced (or opened again) is refused. A run that can't be restored as one
 * is discarded, saying so. The canvas's file is read back with its run, as canvas memory wrote it,
 * from the app's dialogs.
 */
export class RunJournal {
  readonly #deps: JournalDeps;
  readonly #entries = new Map<CanvasId, Entry>();
  /** What opening the database found to say, until the first run restored says it. */
  #said: string | undefined;
  /** Every write asked for so far, written or failed. */
  #writing: Promise<unknown> = Promise.resolve();
  /** What hears a canvas's run journaled, or which canvases are open change. */
  readonly #listeners = new Set<(canvas: CanvasId) => void>();

  constructor(deps: JournalDeps) {
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
           r.updated_at AS updated_at
         FROM canvas c LEFT JOIN run r ON r.canvas_id = c.id
         WHERE c.id = ?`,
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
          state: row.state,
          messages: row.messages,
          updatedAt: row.updated_at,
        });
      } catch (error) {
        // Deleted, so that it is neither read nor said again.
        await this.#write(() => {
          this.#deps.store.prepare('DELETE FROM run WHERE canvas_id = ?').run(canvas);
        });
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
   * Hears a canvas's run journaled, or the canvas the profile has open change: as the write holding
   * it is made. Returns what stops it hearing them.
   */
  subscribe(listener: (canvas: CanvasId) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Throws unless `token` is the canvas's generation's: a renderer's of the canvas it shows. */
  check(canvas: CanvasId, token: string): void {
    if (this.#entry(canvas).token !== token) throw new Error(EARLIER);
  }

  /**
   * Journals a canvas's run (null: none), for the renderer whose token is its canvas's, keeping
   * where each party's `wait` has read to. On disk once it resolves.
   */
  async save(canvas: CanvasId, token: string, checkpoint: RunCheckpoint | null): Promise<void> {
    this.check(canvas, token);
    await this.#write(() => {
      this.keep(canvas, token, checkpoint);
    });
  }

  /**
   * Within a write: journals a canvas's run (null: none), as `save` does, with whatever else the
   * write holds. Throws, failing the write, for a token that isn't its canvas's, or a run it can't
   * journal.
   */
  keep(canvas: CanvasId, token: string, checkpoint: RunCheckpoint | null): void {
    if (this.#entries.get(canvas)?.token !== token) throw new Error(EARLIER);
    const { store, memory } = this.#deps;
    memory.ensure(canvas);
    this.#markOpen(canvas);
    if (checkpoint === null) {
      store.prepare('DELETE FROM run WHERE canvas_id = ?').run(canvas);
      return;
    }
    const { version, state, messages, updatedAt } = parseRunCheckpoint(checkpoint);
    if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_RUN_BYTES) {
      throw new RangeError('The run checkpoint is too large');
    }
    // Its state and messages are JSON texts (parseRunCheckpoint read them): kept as they are.
    store
      .prepare(
        `INSERT INTO run (canvas_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(
        canvas,
        `{"version":${String(version)},"state":${state},"messages":${messages}}`,
        updatedAt,
      );
    this.#tell(canvas);
  }

  /** Within a write: moves `party`'s read position in the canvas's messages forward to `seq`. */
  moveRead(canvas: CanvasId, party: PartyId, seq: number): void {
    this.#deps.memory.ensure(canvas);
    this.#deps.store
      .prepare(
        `INSERT INTO read_position (canvas_id, party, seq) VALUES (?, ?, ?)
         ON CONFLICT (canvas_id, party) DO UPDATE SET seq = max(seq, excluded.seq)`,
      )
      .run(canvas, party, seq);
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

  /** Resolves once every write asked for so far is done. */
  async flush(): Promise<void> {
    await this.#writing;
  }

  #entry(canvas: CanvasId): Entry {
    let entry = this.#entries.get(canvas);
    if (entry === undefined) {
      entry = { token: randomUUID() };
      this.#entries.set(canvas, entry);
    }
    return entry;
  }

  /** Writes to the database: resolves once the commit holding it returned. */
  #write(write: () => void): Promise<void> {
    const written = this.#deps.store.write(write);
    this.#writing = Promise.all([this.#writing, written.catch(() => undefined)]);
    return written;
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
    this.#tell(canvas);
  }

  /** Tells what hears it of `canvas`. */
  #tell(canvas: CanvasId): void {
    for (const listener of this.#listeners) {
      try {
        listener(canvas);
      } catch (error) {
        console.error('Could not tell of a journaled run:', error);
      }
    }
  }
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
