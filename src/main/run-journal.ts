import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isCanvasId, newCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { MAX_CANVAS_BYTES } from '../shared/ipc';
import type { PartyId } from '../shared/model/messages';
import type { NeedsItem } from '../shared/model/needs';
import { MAX_RUN_BYTES, parseRunCheckpoint } from '../shared/run';
import type { RunCheckpoint, RunContext } from '../shared/run';
import type { MessageStore } from './core/delivery/messages';
import { keepSubmissions, recordsIn, submissionsOf } from './core/delivery/submissions';
import { mintTrustedPath } from './core/host';
import type { TrustedPath } from './core/host';
import type { Database } from './core/store/store';
import type { CanvasMemory } from './memory';

/** What the journal keeps of a canvas a window shows: its generation's token, and what to say. */
interface Entry {
  token: string;
  warning?: string;
  /** Whether what the store said as it opened is in its warning yet. */
  said?: boolean;
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
  /**
   * The canvas's messages, the core's one store of them (Engines.messagesOf): where a run's
   * manual submissions are kept, as your messages (delivery/submissions.ts).
   */
  messages: (canvas: CanvasId) => Promise<MessageStore>;
  /** What opening the database found to say (core/store/open.ts): said with the first run restored. */
  said?: readonly string[];
  problemChanged?: (canvas: CanvasId) => void;
}

const MISSING = 'The saved canvas is missing. Its run was restored as an unsaved canvas.';
/** A run journaled in no envelope this corrallm reads (one migration 4 couldn't convert). */
const UNREADABLE = 'it was kept in a form this corrallm can’t read';
const EARLIER = 'This run belongs to an earlier canvas';
const TOO_LARGE =
  'The run checkpoint is too large (over 32 MiB), so current run progress cannot be kept. Further run prompts are held; parties’ messages are still recorded and delivered. Restarting restores only the last checkpoint that fit, if any.';
const TOO_COMPLEX =
  'The run checkpoint is too complex (too many JSON values or nesting too deep), so current run progress cannot be kept. Further run prompts are held; parties’ messages are still recorded and delivered. Restarting restores only the last checkpoint that fit, if any.';

/**
 * Each canvas's run, journaled by the canvas's id in the profile's database (Core Database §5),
 * where each party's `wait` has read to in its messages, and the canvas the profile had open last:
 *
 *   run            the run's state, in its envelope (B11 Design §4: `{ format: 3, run, saveError? }`;
 *                  the document it runs is the core's: core/canvas/documents.ts)
 *   read_position  each party's read position in the canvas's messages
 *   open_canvas    each canvas open, until it is closed, and when it was used last: a window that
 *                  shows none restores the one used last
 *
 * Its writes go through the database's write lane, in order, each on the drive once it resolves
 * (the commit that holds it returned and the log was flushed); the core's canvases journal their
 * runs within writes of their own (`keep`, `moveRead`), with what else commits with them (their
 * messages; every position a `wait` moves). A save keeps the read positions as they are: only a `wait` moves one, and only
 * forward. A window's renderer saves with the token of the canvas it showed: a save meant for a
 * canvas it has since replaced (or opened again) is refused. A run that can't be restored as one
 * is discarded, saying so. The canvas's file is read back with its run, as canvas memory wrote it,
 * from the app's dialogs. A checkpoint's manual submissions are never kept beside its run: each is
 * your message in the canvas's messages, in the same write, and given back from there as the run
 * is restored (delivery/submissions.ts), until B11's views replace submissions.
 */
export class RunJournal {
  readonly #deps: JournalDeps;
  readonly #entries = new Map<CanvasId, Entry>();
  readonly #problems = new Map<CanvasId, string | undefined>();
  /** What opening the database found to say, with each canvas's run restored. */
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

  /**
   * The canvases open (`open_canvas`: until each is closed), the one used longest ago first: what
   * a core starting cold initializes (Engines.initialize). Rejects if they can't be read.
   */
  async openCanvases(): Promise<CanvasId[]> {
    await this.flush();
    return this.#deps.store
      .prepare('SELECT canvas_id FROM open_canvas ORDER BY opened_at, canvas_id')
      .all()
      .flatMap(({ canvas_id: id }) => (isCanvasId(id) ? [id] : []));
  }

  /**
   * What a window showing `canvas`, or the core opening it, restores: its run, what to say of it,
   * and its file's text as it is on disk (none for a canvas with no file, or whose file is gone).
   */
  async get(canvas: CanvasId): Promise<RunContext & { savedText?: string; warning?: string }> {
    await this.flush();
    const entry = this.#entry(canvas);
    const row = this.#deps.store
      .prepare(
        `SELECT c.file AS file, r.canvas_id AS ran, json_extract(r.state, '$.format') AS format,
           json_extract(r.state, '$.run') AS state, r.updated_at AS updated_at,
           json_extract(r.state, '$.saveError') AS save_error
         FROM canvas c LEFT JOIN run r ON r.canvas_id = c.id
         WHERE c.id = ?`,
      )
      .get(canvas);
    // Said with every canvas restored, once each: the core runs every canvas open as it starts (B11
    // Design §2), so the first restored need not be the one a window shows.
    if (this.#said !== undefined && entry.said !== true) {
      entry.warning = [this.#said, entry.warning].filter(Boolean).join(' ');
      entry.said = true;
    }
    let checkpoint: RunCheckpoint | null = null;
    const saveError = typeof row?.save_error === 'string' ? row.save_error : undefined;
    // A size refusal journaled with no checkpoint that fit restores none.
    if (typeof row?.ran === 'string' && !(row.format === 3 && row.state === null)) {
      try {
        if (row.format !== 3) throw new TypeError(UNREADABLE);
        checkpoint = parseRunCheckpoint({
          version: 2,
          state: row.state,
          messages: submissionsOf(await this.#deps.messages(canvas)),
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
    return {
      id: canvas,
      token: entry.token,
      checkpoint,
      ...(savedText === undefined ? {} : { savedText }),
      ...(entry.warning === undefined ? {} : { warning: entry.warning }),
      ...(saveError === undefined ? {} : { saveError }),
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
   * where each party's `wait` has read to, with its submissions, your messages. On disk once it
   * resolves.
   */
  async save(canvas: CanvasId, token: string, checkpoint: RunCheckpoint | null): Promise<void> {
    this.check(canvas, token);
    const messages = await this.#deps.messages(canvas);
    let written: () => void = () => undefined;
    const problem = await this.#write(() => {
      const kept = this.keep(canvas, token, checkpoint, messages);
      written = messages.changes();
      return kept;
    });
    written();
    this.kept(canvas, problem);
    if (problem !== undefined) throw new RangeError(problem);
  }

  /**
   * Within a write: journals a canvas's run (null: none), as `save` does, with whatever else the
   * write holds, its submissions your messages in `messages`, the canvas's store, whose changes
   * the write must hold too (a record no engine restores left out). A run beyond the size or
   * complexity bound keeps its refusal beside the last good checkpoint, and none of its
   * submissions; other invalid data, SQL failures and a wrong token still throw.
   */
  keep(
    canvas: CanvasId,
    token: string,
    checkpoint: RunCheckpoint | null,
    messages: MessageStore,
  ): string | undefined {
    if (this.#entries.get(canvas)?.token !== token) throw new Error(EARLIER);
    const { store, memory } = this.#deps;
    memory.ensure(canvas);
    this.#markOpen(canvas);
    if (checkpoint === null) {
      store.prepare('DELETE FROM run WHERE canvas_id = ?').run(canvas);
      return;
    }
    if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_RUN_BYTES) {
      // A size limit is not a drive failure. Retain the last good run and commit this marker
      // with its messages, rather than rolling messages back or sending without their record.
      return this.#refused(canvas, checkpoint, TOO_LARGE);
    }
    let parsed: RunCheckpoint;
    try {
      parsed = parseRunCheckpoint(checkpoint);
    } catch (error) {
      if (error instanceof RangeError) return this.#refused(canvas, checkpoint, TOO_COMPLEX);
      throw error;
    }
    const { state, updatedAt } = parsed;
    // Its submission records, read before anything is written.
    const submissions = recordsIn(parsed.messages);
    // Its state is a JSON text (parseRunCheckpoint read it): kept as it is.
    store
      .prepare(
        `INSERT INTO run (canvas_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(canvas, `{"format":3,"run":${state}}`, updatedAt);
    keepSubmissions(messages, submissions, Date.now());
    return undefined;
  }

  /** Keep the last good checkpoint and this bound's marker in the containing message write. */
  #refused(canvas: CanvasId, checkpoint: RunCheckpoint, problem: string): string {
    this.#deps.store
      .prepare(
        `INSERT INTO run (canvas_id, state, updated_at)
           VALUES (?, json_object('format', 3, 'saveError', ?), ?)
         ON CONFLICT(canvas_id) DO UPDATE SET state = json_set(run.state, '$.saveError', ?)`,
      )
      .run(canvas, problem, checkpoint.updatedAt, problem);
    return problem;
  }

  /** Called only after the containing write is durable, including a bound refusal's marker. */
  kept(canvas: CanvasId, problem: string | undefined): void {
    const before = this.#problems.get(canvas);
    this.#problems.set(canvas, problem);
    if (before !== problem) this.#deps.problemChanged?.(canvas);
    this.#tell(canvas);
  }

  /** The persisted size or complexity refusal, cached until another run write lands. */
  problem(canvas: CanvasId): string | undefined {
    if (!this.#problems.has(canvas)) {
      const value = this.#deps.store
        .prepare("SELECT json_extract(state, '$.saveError') AS error FROM run WHERE canvas_id = ?")
        .get(canvas)?.error;
      this.#problems.set(canvas, typeof value === 'string' ? value : undefined);
    }
    return this.#problems.get(canvas);
  }

  /** A canvas-wide hold: no answer can make an unbounded checkpoint durable. */
  items(canvas: CanvasId): NeedsItem[] {
    const problem = this.problem(canvas);
    return problem === undefined
      ? []
      : [
          {
            id: `unsaved/${encodeURIComponent(canvas)}`,
            canvas,
            kind: 'hold',
            for: 'you',
            by: [],
            title:
              problem === TOO_COMPLEX
                ? 'Run progress is too complex to save'
                : 'Run progress is too large to save',
            detail: problem,
            choices: [],
            answerIn: 'api',
          },
        ];
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

  /** The canvas is open (the core runs it): until it is closed, beside any other open. */
  async open(canvas: CanvasId): Promise<void> {
    await this.#write(() => {
      this.#markOpen(canvas);
    });
  }

  /**
   * A canvas was saved (Save As too, which keeps its id): if it is open, it is the one the profile
   * used last. One closed stays closed.
   */
  async saved(canvas: CanvasId): Promise<void> {
    await this.#write(() => {
      this.#deps.store
        .prepare('UPDATE open_canvas SET opened_at = ? WHERE canvas_id = ?')
        .run(this.#nextOpen(), canvas);
      this.#tell(canvas);
    });
  }

  /**
   * The canvas is closed (B9 Design §2): no longer open, so a window that shows none restores
   * another, and canvas memory may forget it once it is used least recently and holds no edits.
   * What is kept of it stays. On disk once it resolves.
   */
  async close(canvas: CanvasId): Promise<void> {
    await this.#write(() => {
      this.#deps.store.prepare('DELETE FROM open_canvas WHERE canvas_id = ?').run(canvas);
      this.#tell(canvas);
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
  #write<T>(write: () => T): Promise<T> {
    const written = this.#deps.store.write(write);
    this.#writing = Promise.all([this.#writing, written.catch(() => undefined)]);
    return written;
  }

  /**
   * Within a write: `canvas` is open, the one the profile used last: open beside the others open,
   * until it is closed.
   */
  #markOpen(canvas: CanvasId): void {
    const { store, memory } = this.#deps;
    memory.ensure(canvas);
    store
      .prepare(
        `INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, ?)
         ON CONFLICT (canvas_id) DO UPDATE SET opened_at = excluded.opened_at`,
      )
      .run(canvas, this.#nextOpen());
    this.#tell(canvas);
  }

  /**
   * Within a write: when a canvas used now was: now, unless another was opened at or after it (in
   * the same millisecond, or by a clock set back since), then just after that one.
   */
  #nextOpen(): number {
    const last = this.#deps.store
      .prepare('SELECT max(opened_at) AS last FROM open_canvas')
      .get()?.last;
    return Math.max(Date.now(), typeof last === 'number' ? last + 1 : 0);
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
