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
/** How many canvases it remembers: the ones used most recently. */
const LIMIT = 200;

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
 * LIMIT canvases used most recently (`used_at`, which each change moves past every other's),
 * forgetting the others with everything the database keeps of them. The paths it reads back are
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

  constructor(store: Database, limit = LIMIT) {
    this.#store = store;
    this.#limit = limit;
  }

  /** What it remembers of a canvas, with every change asked for so far. */
  async get(canvas: CanvasId): Promise<Remembered> {
    await this.#writing;
    return this.#current(canvas);
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
    if (made.changes > 0) this.#forgetOldest();
  }

  /** Resolves once every change so far is on disk; rejects while a write that failed isn't. */
  async flush(): Promise<void> {
    await this.#writing;
    if (this.#writeError !== undefined) throw this.#writeError;
  }

  /** Makes a change, then writes every canvas changed whose row isn't on disk as it is. */
  #change(apply: () => void): Promise<void> {
    let written: () => void = () => undefined;
    const writing = this.#store
      .write(() => {
        apply();
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
      );
    this.#writing = Promise.all([this.#writing, writing]);
    return writing;
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

  /** Forgets every canvas but the LIMIT used most recently, with all the database keeps of them. */
  #forgetOldest(): void {
    this.#store
      .prepare(
        `DELETE FROM canvas WHERE id IN
           (SELECT id FROM canvas ORDER BY used_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(this.#limit);
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
