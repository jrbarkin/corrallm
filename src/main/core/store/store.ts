import { takeSnapshot } from './snapshots';
import type { Connection, Statement } from './sqlite';
import { rollback, savepoint, transaction } from './transaction';

/*
 * The core's database (Core Database §4, §5), open: one connection to <profile>/core.db, which only
 * the core writes (it holds core.lock). openStore (open.ts) opens it.
 *
 * Writes go through one lane (group commit): the writes queued within one turn of the core's loop
 * share one transaction, each in a savepoint of its own, so one that fails rolls back only itself
 * and rejects only its caller. Each resolves with what its function returned only once the commit
 * that holds it has returned: a write is on disk when its promise resolves, which is what "its
 * record on disk before it is sent" means. A commit that fails rejects every write it held, and
 * the writes after it are a batch of their own. Commits block the loop (node:sqlite is
 * synchronous), so batching them amortizes the one sync each costs among every write it holds.
 *
 * SQLite checkpoints nothing by itself (wal_autocheckpoint is off: its checkpoints would land in
 * the middle of a commit): the store checkpoints its log into the database once it is idle
 * (PASSIVE: never waiting for a reader), and truncates the log as it closes.
 *
 * It takes a snapshot of itself (snapshots.ts) as it closes, and every SNAPSHOT_EVERY_MS once
 * idle after writes: the first as soon as it is, if the profile has none.
 */

/** What the store's timers and snapshots' times run on: in tests, by the test's hand. */
export interface StoreDeps {
  /** Runs `run` after `ms`; returns what cancels it. */
  later: (run: () => void, ms: number) => () => void;
  /** The time, in epoch ms. */
  now: () => number;
}

/** The real clock. A checkpoint's timer keeps no process running: the log is on disk already. */
export const SYSTEM_DEPS: StoreDeps = {
  later: (run, ms) => {
    const timer = setTimeout(run, ms).unref();
    return () => {
      clearTimeout(timer);
    };
  },
  now: () => Date.now(),
};

/**
 * How long the store waits after a commit for no other before it checkpoints its log into the
 * database: a second, so a checkpoint (milliseconds of the loop, more for a long log) falls
 * between bursts of work, not in their middle.
 */
const CHECKPOINT_IDLE_MS = 1000;
/** The longest a store that never pauses goes without checkpointing, so its log stays short. */
const CHECKPOINT_AT_MOST_MS = 30_000;
/**
 * How often the store takes a snapshot of itself besides as it closes: every four hours, so the
 * three kept span most of a day's work, and restoring one loses at most a few hours of it.
 */
export const SNAPSHOT_EVERY_MS = 4 * 3600_000;

/** What the store is opened with besides its connection. */
export interface Opening {
  profile: string;
  /** The database's file. */
  file: string;
  deps: StoreDeps;
  /** When the profile's newest snapshot was taken, if it has one. */
  snapshotAt: number | undefined;
}

/** A write waiting in the lane. */
interface Queued {
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class Store {
  /** The database's file. */
  readonly file: string;
  readonly #profile: string;
  readonly #connection: Connection;
  readonly #deps: StoreDeps;
  /** Each statement prepared, by its SQL. */
  readonly #statements = new Map<string, Statement>();
  /** The writes waiting for the lane's next commit, in order. */
  #queue: Queued[] = [];
  #scheduled = false;
  /** Cancels the checkpoint due, if one is. */
  #cancelCheckpoint: (() => void) | undefined;
  /** When the first commit the log holds unchecked came, if one did. */
  #uncheckpointedSince: number | undefined;
  /** When the newest snapshot was taken, if one was. */
  #snapshotAt: number | undefined;
  /** The snapshot being taken, if one is. */
  #snapshotting: Promise<string> | undefined;
  /**
   * Whether the store is closing: set before it commits what was queued, so that a write those
   * queue is refused rather than committed once it has closed.
   */
  #shut = false;
  #closing: Promise<void> | undefined;

  constructor(connection: Connection, { profile, file, deps, snapshotAt }: Opening) {
    this.#connection = connection;
    this.#profile = profile;
    this.file = file;
    this.#deps = deps;
    this.#snapshotAt = snapshotAt;
  }

  /**
   * A statement, prepared once for its SQL: SQL with parameters for its values, never the values
   * themselves, or each would be kept apart.
   */
  prepare(sql: string): Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#connection.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Runs SQL without parameters (statements separated by semicolons). */
  exec(sql: string): void {
    this.#connection.exec(sql);
  }

  /**
   * Runs `run` in a transaction, committed once it returns, and returns what it returned; within
   * one, as a savepoint (transaction.ts). Synchronous: what it did is on disk once it returns.
   * Refused once the store is closing, but within a write it commits.
   */
  tx<T>(run: () => T): T {
    const outermost = !this.#connection.isTransaction;
    if (outermost && this.#shut) throw closed();
    const value = transaction(this.#connection, run);
    if (outermost) this.#committed();
    return value;
  }

  /**
   * Queues `run` (synchronous, with no await inside) for the lane's next commit, with the other
   * writes queued in this turn of the loop. Resolves with what it returned once that commit has
   * returned; rejects, keeping nothing of it, if it threw or the commit failed. Refused once the
   * store is closing.
   */
  write<T>(run: () => T): Promise<T> {
    if (this.#shut) return Promise.reject(closed());
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ run, resolve: resolve as (value: unknown) => void, reject });
      if (this.#scheduled) return;
      this.#scheduled = true;
      setImmediate(() => {
        this.#scheduled = false;
        this.#flush();
      });
    });
  }

  /**
   * Takes a snapshot of the database now, as it goes on being written (one at a time: asked for
   * while one is being taken, it is that one). Resolves with its file.
   */
  snapshot(): Promise<string> {
    if (this.#snapshotting !== undefined) return this.#snapshotting;
    const at = this.#deps.now();
    const taking = takeSnapshot(this.file, this.#profile, at).finally(() => {
      this.#snapshotting = undefined;
    });
    this.#snapshotting = taking;
    this.#snapshotAt = at;
    return taking;
  }

  /**
   * Closes the database once the writes queued so far are committed, checkpointing its log into it
   * and taking a snapshot of it. Writes asked for meanwhile are refused. Closing it again does
   * nothing more.
   */
  close(): Promise<void> {
    if (this.#closing === undefined) {
      this.#shut = true;
      this.#closing = this.#close();
    }
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#flush();
    this.#cancelCheckpoint?.();
    await this.#snapshotting?.catch(() => undefined);
    try {
      this.#connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch (error) {
      console.error('Could not checkpoint the core’s database as it closed:', error);
    }
    try {
      await this.snapshot();
    } catch (error) {
      console.error('Could not take a snapshot of the core’s database as it closed:', error);
    }
    this.#connection.close();
  }

  /** Commits every write queued, a batch at a time. */
  #flush(): void {
    let batch = this.#queue;
    this.#queue = [];
    while (batch.length > 0) batch = this.#commit(batch);
  }

  /** Commits a batch of writes in one transaction; returns those it didn't run. */
  #commit(batch: Queued[]): Queued[] {
    try {
      this.#connection.exec('BEGIN IMMEDIATE');
    } catch (error) {
      for (const write of batch) write.reject(error);
      return [];
    }
    const done: [write: Queued, value: unknown][] = [];
    for (const [i, write] of batch.entries()) {
      try {
        done.push([write, savepoint(this.#connection, write.run)]);
      } catch (error) {
        write.reject(error);
        if (!this.#connection.isTransaction) {
          // SQLite rolled the whole transaction back (as on a full disk): what the batch wrote
          // before is gone too, and the writes after it are a batch of their own.
          for (const [lost] of done) lost.reject(error);
          return batch.slice(i + 1);
        }
      }
    }
    try {
      this.#connection.exec('COMMIT');
    } catch (error) {
      rollback(this.#connection);
      for (const [lost] of done) lost.reject(error);
      return [];
    }
    for (const [write, value] of done) write.resolve(value);
    this.#committed();
    return [];
  }

  /** Sets the checkpoint due once the store is idle, or at most so long after the first commit. */
  #committed(): void {
    this.#cancelCheckpoint?.();
    const now = this.#deps.now();
    this.#uncheckpointedSince ??= now;
    const due = this.#uncheckpointedSince + CHECKPOINT_AT_MOST_MS - now;
    this.#cancelCheckpoint = this.#deps.later(
      () => {
        this.#checkpoint();
      },
      Math.max(0, Math.min(CHECKPOINT_IDLE_MS, due)),
    );
  }

  /** Once idle: checkpoints the log, and takes the snapshot due, if one is. */
  #checkpoint(): void {
    this.#cancelCheckpoint = undefined;
    this.#uncheckpointedSince = undefined;
    try {
      this.#connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    } catch (error) {
      console.error('Could not checkpoint the core’s database:', error);
    }
    if (
      this.#snapshotAt === undefined ||
      this.#deps.now() - this.#snapshotAt >= SNAPSHOT_EVERY_MS
    ) {
      this.snapshot().catch((error: unknown) => {
        console.error('Could not take a snapshot of the core’s database:', error);
      });
    }
  }
}

function closed(): Error {
  return new Error('The core’s database is closed.');
}

/**
 * What the stores kept in the database (canvas memory, the run journal) read and write it through:
 * the open store, or, when it couldn't be opened, one that refuses (`unopened`).
 */
export type Database = Pick<Store, 'prepare' | 'write'>;

/**
 * The database of a core whose store couldn't be opened: every read and write fails, saying `why`,
 * so the core journals nothing, and sends nothing whose record must be on disk first.
 */
export function unopened(why: string): Database {
  return {
    prepare: () => {
      throw new Error(why);
    },
    write: () => Promise.reject(new Error(why)),
  };
}
