import { createHash } from 'node:crypto';
import path from 'node:path';

import { ID_PATTERN } from '../shared/adapter';
import { isCanvasId } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import { mintTrustedPath } from './core/host';
import type { TrustedPath } from './core/host';
import type { Database } from './core/store/store';
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
 * What the core remembers of a canvas: the file it was opened from or saved to (none for a draft),
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
/**
 * How many canvases it keeps with a file, folder or conversations, the ones used most recently, and
 * how many drafts besides.
 */
const LIMIT = 200;
/** A canvas kept with a file, folder or conversations: not a draft, which has its run at most. */
const KEPT = `(file IS NOT NULL OR project IS NOT NULL
  OR EXISTS (SELECT 1 FROM conversation WHERE conversation.canvas_id = canvas.id))`;

/**
 * What the core remembers of each canvas between runs, by the canvas's id, in the profile's
 * database (core/store/): its row in `canvas` (its file and project folder) and its agents' rows in
 * `conversation`. The canvas file itself only holds what the canvas means
 * (src/shared/model/file.ts), so it can be shared: where it is and where it runs on this machine is
 * kept here.
 *
 * A file belongs to one canvas at most. Changes go through the store's write lane, in order, each
 * reading what those before it left, and are on disk once they resolve. A change is remembered as
 * it is made (what `get` reads), and written with every canvas changed whose row isn't on disk as
 * it is yet: one whose write failed is said, written again with the next, and fails `flush` until
 * it is on disk, so no conversation remembered is lost to a write that failed once. It keeps the
 * LIMIT canvases used most recently (`used_at`, which each change moves past every other's) with a
 * file, folder or conversations, and the LIMIT drafts used most recently (each New makes one, with
 * its run), forgetting the others with everything the database keeps of them: drafts never push
 * out a canvas kept for its file or folder. The paths it reads back are
 * trusted: it wrote them, from the app's dialogs. What isn't right (a path that isn't absolute, a
 * conversation whose id isn't a session's) is left out.
 */
export class CanvasMemory {
  readonly #store: Database;
  readonly #limit: number;
  /** Every change asked for so far, written or failed. */
  #writing: Promise<unknown> = Promise.resolve();
  /**
   * The canvases changed whose rows aren't on disk as they are yet, as changed (the canvas changed
   * last, last), each with the number of its last change: a write marks one on disk only if it
   * hasn't changed since.
   */
  readonly #unwritten = new Map<CanvasId, { remembered: Remembered; change: number }>();
  #changes = 0;
  /** Why the last write failed, until a write leaves nothing unwritten. */
  #writeError: Error | undefined;
  /** What hears a canvas it keeps change (undefined: which canvases it keeps). */
  readonly #listeners = new Set<(canvas: CanvasId | undefined) => void>();
  /** The canvases the change being applied changed. */
  #touched: CanvasId[] = [];

  constructor(store: Database, limit = LIMIT) {
    this.#store = store;
    this.#limit = limit;
  }

  /** What it remembers of a canvas, with every change asked for so far. */
  async get(canvas: CanvasId): Promise<Remembered> {
    await this.#writing;
    return this.#current(canvas);
  }

  /**
   * Every canvas it keeps, the one used most recently first, with every change asked for so far:
   * its file and its folder.
   */
  async list(): Promise<{ canvas: CanvasId; file?: TrustedPath; project?: TrustedPath }[]> {
    await this.#writing;
    const changed = [...this.#unwritten].reverse();
    const kept = this.#store
      .prepare('SELECT id, file, project FROM canvas ORDER BY used_at DESC')
      .all()
      .flatMap(({ id, file, project }) =>
        isCanvasId(id) && !this.#unwritten.has(id)
          ? [
              {
                canvas: id,
                ...(isAbsolute(file) ? { file: mintTrustedPath(file) } : {}),
                ...(isAbsolute(project) ? { project: mintTrustedPath(project) } : {}),
              },
            ]
          : [],
      );
    return [
      ...changed.map(
        ([
          canvas,
          {
            remembered: { file, project },
          },
        ]) => ({
          canvas,
          ...(file === undefined ? {} : { file }),
          ...(project === undefined ? {} : { project }),
        }),
      ),
      ...kept,
    ];
  }

  /** Whether it keeps `canvas`, with every change asked for so far. */
  keeps(canvas: CanvasId): boolean {
    return (
      this.#unwritten.has(canvas) ||
      this.#store.prepare('SELECT 1 AS kept FROM canvas WHERE id = ?').get(canvas) !== undefined
    );
  }

  /**
   * Hears what it keeps change: a canvas's file, folder or conversations (once the change is
   * written, or failed to be), and which canvases it keeps (undefined, as it is changed). Returns
   * what stops it hearing them.
   */
  subscribe(listener: (canvas: CanvasId | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The canvas whose file `file` is, if any. */
  async canvasWithFile(file: string): Promise<CanvasId | undefined> {
    await this.#writing;
    return this.#withFile(file);
  }

  /** Changes what it remembers of `canvas`, which becomes the canvas used most recently. */
  update(canvas: CanvasId, change: (remembered: Remembered) => Remembered): Promise<void> {
    return this.#change(() => {
      this.#set(canvas, change(this.#current(canvas)));
    });
  }

  /**
   * Sets the file a canvas is opened from and saved to (undefined: none, a draft's). Another canvas
   * that had that file has it no more.
   */
  setFile(canvas: CanvasId, file: TrustedPath | undefined): Promise<void> {
    return this.#change(() => {
      const other = file === undefined ? undefined : this.#withFile(file);
      if (other !== undefined && other !== canvas) {
        this.#set(other, withFile(this.#current(other), undefined));
      }
      this.#set(canvas, withFile(this.#current(canvas), file));
    });
  }

  /**
   * Within a write: gives `canvas` a row if it has none, as the canvas used most recently, for what
   * else the database keeps of it (a draft's run) to refer to. One that has a row keeps it as it is.
   */
  ensure(canvas: CanvasId): void {
    const made = this.#store
      .prepare('INSERT INTO canvas (id, used_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
      .run(canvas, this.#nextUse());
    if (made.changes > 0) {
      this.#forgetOldest();
      this.#tell(undefined);
    }
  }

  /** Resolves once every change so far is on disk; rejects while a write that failed isn't. */
  async flush(): Promise<void> {
    await this.#writing;
    if (this.#writeError !== undefined) throw this.#writeError;
  }

  /** Makes a change, then writes every canvas changed whose row isn't on disk as it is. */
  #change(apply: () => void): Promise<void> {
    let written: () => void = () => undefined;
    let touched: CanvasId[] = [];
    const writing = this.#store
      .write(() => {
        this.#touched = [];
        apply();
        touched = this.#touched;
        written = this.#writeUnwritten();
      })
      .then(
        () => {
          written();
          if (this.#unwritten.size === 0) this.#writeError = undefined;
        },
        // Ordinary changes remain nonfatal, but shutdown must not lose native resume IDs: what
        // failed stays unwritten, for the next write, and fails `flush` meanwhile.
        (error: unknown) => {
          this.#writeError = error instanceof Error ? error : new Error(String(error));
          console.error('Could not remember the canvas:', error);
        },
      )
      .then(() => {
        for (const canvas of new Set(touched)) this.#tell(canvas);
      });
    this.#writing = Promise.all([this.#writing, writing]);
    return writing;
  }

  /** Tells what hears it that `canvas` changed (undefined: which canvases it keeps). */
  #tell(canvas: CanvasId | undefined): void {
    for (const listener of this.#listeners) {
      try {
        listener(canvas);
      } catch (error) {
        console.error('Could not tell of a remembered canvas:', error);
      }
    }
  }

  /**
   * Within a write: every canvas changed whose row isn't on disk as it is, as the canvas used most
   * recently (the one changed last, last), each file cleared first from any other row that has it;
   * then the canvases used least recently forgotten. Returns what marks them on disk once the
   * write's commit returned.
   */
  #writeUnwritten(): () => void {
    const written = [...this.#unwritten];
    const clear = this.#store.prepare('UPDATE canvas SET file = NULL WHERE file = ? AND id <> ?');
    for (const [canvas, { remembered }] of written) {
      if (remembered.file !== undefined) clear.run(remembered.file, canvas);
    }
    for (const [canvas, { remembered }] of written) this.#keep(canvas, remembered);
    this.#forgetOldest();
    return () => {
      for (const [canvas, { change }] of written) {
        if (this.#unwritten.get(canvas)?.change === change) this.#unwritten.delete(canvas);
      }
    };
  }

  /** What it remembers of a canvas now: as changed, else as on disk. */
  #current(canvas: CanvasId): Remembered {
    return this.#unwritten.get(canvas)?.remembered ?? this.#read(canvas);
  }

  /** Remembers `canvas` as `remembered`, its row unwritten until a write has it on disk. */
  #set(canvas: CanvasId, remembered: Remembered): void {
    this.#unwritten.delete(canvas);
    this.#unwritten.set(canvas, { remembered, change: ++this.#changes });
    this.#touched.push(canvas);
  }

  /** The canvas whose file `file` is now, if any. */
  #withFile(file: string): CanvasId | undefined {
    for (const [canvas, { remembered }] of this.#unwritten) {
      if (remembered.file === file) return canvas;
    }
    const id = this.#store.prepare('SELECT id FROM canvas WHERE file = ?').get(file)?.id;
    return isCanvasId(id) && !this.#unwritten.has(id) ? id : undefined;
  }

  #read(canvas: CanvasId): Remembered {
    const row = this.#store.prepare('SELECT file, project FROM canvas WHERE id = ?').get(canvas);
    if (row === undefined) return NOTHING;
    const byAdapter = new Map<string, [agent: string, conversation: Conversation][]>();
    const rows = this.#store
      .prepare(
        `SELECT adapter, agent_id, native_id, role_fingerprint FROM conversation
         WHERE canvas_id = ? ORDER BY adapter, agent_id`,
      )
      .all(canvas);
    for (const { adapter, agent_id: agent, native_id: id, role_fingerprint: role } of rows) {
      if (typeof adapter !== 'string' || !ID_PATTERN.test(adapter)) continue;
      if (typeof agent !== 'string' || !isSessionId(id)) continue;
      const agents = byAdapter.get(adapter) ?? [];
      agents.push([agent, isFingerprint(role) ? { id, role } : { id }]);
      byAdapter.set(adapter, agents);
    }
    const { file, project } = row;
    return {
      ...(isAbsolute(file) ? { file: mintTrustedPath(file) } : {}),
      ...(isAbsolute(project) ? { project: mintTrustedPath(project) } : {}),
      conversations: Object.fromEntries(
        [...byAdapter].map(([adapter, agents]) => [adapter, Object.fromEntries(agents)]),
      ),
    };
  }

  /**
   * Writes what is remembered of `canvas`, as the canvas used most recently: its row, and its
   * conversations (those it no longer has deleted; each column written by name, so that what a
   * newer corrallm keeps beside them stays).
   */
  #keep(canvas: CanvasId, { file, project, conversations }: Remembered): void {
    this.#store
      .prepare(
        `INSERT INTO canvas (id, file, project, used_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           file = excluded.file, project = excluded.project, used_at = excluded.used_at`,
      )
      .run(canvas, file ?? null, project ?? null, this.#nextUse());
    const kept = this.#store
      .prepare('SELECT adapter, agent_id FROM conversation WHERE canvas_id = ?')
      .all(canvas);
    const forget = this.#store.prepare(
      'DELETE FROM conversation WHERE canvas_id = ? AND adapter = ? AND agent_id = ?',
    );
    for (const { adapter, agent_id: agent } of kept) {
      const agents =
        typeof adapter === 'string' && Object.hasOwn(conversations, adapter)
          ? conversations[adapter]
          : undefined;
      if (agents === undefined || typeof agent !== 'string' || !Object.hasOwn(agents, agent)) {
        forget.run(canvas, adapter ?? null, agent ?? null);
      }
    }
    const remember = this.#store.prepare(
      `INSERT INTO conversation (canvas_id, adapter, agent_id, native_id, role_fingerprint)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (canvas_id, adapter, agent_id) DO UPDATE SET
         native_id = excluded.native_id, role_fingerprint = excluded.role_fingerprint`,
    );
    for (const [adapter, agents] of Object.entries(conversations)) {
      for (const [agent, { id, role }] of Object.entries(agents)) {
        remember.run(canvas, adapter, agent, id, role ?? null);
      }
    }
  }

  /**
   * When a canvas used now was used: now, unless another was used at or after it (in the same
   * millisecond, or by a clock set back since), then just after that one.
   */
  #nextUse(): number {
    const last = this.#store.prepare('SELECT max(used_at) AS last FROM canvas').get()?.last;
    return Math.max(Date.now(), typeof last === 'number' ? last + 1 : 0);
  }

  /**
   * Forgets every canvas kept with a file, folder or conversations but the LIMIT used most
   * recently, and every draft but the LIMIT used most recently, with all the database keeps of
   * them.
   */
  #forgetOldest(): void {
    let forgot = 0;
    for (const kind of [KEPT, `NOT ${KEPT}`]) {
      forgot += Number(
        this.#store
          .prepare(
            `DELETE FROM canvas WHERE id IN
               (SELECT id FROM canvas WHERE ${kind} ORDER BY used_at DESC LIMIT -1 OFFSET ?)`,
          )
          .run(this.#limit).changes,
      );
    }
    if (forgot > 0) this.#tell(undefined);
  }
}

/** `remembered` with its file set (undefined: none). */
function withFile(remembered: Remembered, file: TrustedPath | undefined): Remembered {
  const next = { ...remembered };
  if (file === undefined) delete next.file;
  else next.file = file;
  return next;
}

/** A role's fingerprint as roleFingerprint gives it. */
function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && (value === 'none' || /^[a-f0-9]{64}$/.test(value));
}

function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}
