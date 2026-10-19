import { closeSync, fsync, fsyncSync, openSync } from 'node:fs';

import { Checkpointer } from './checkpointer';
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
 * that holds it has returned and the log it was written to has been flushed to the drive: a write
 * is on disk when its promise resolves, which is what "its record on disk before it is sent"
 * means. A commit that fails, or whose flush fails, rejects every write it held, and the writes
 * after it are a batch of their own. A commit runs on the loop (node:sqlite is synchronous), but
 * SQLite syncs nothing as it commits (synchronous NORMAL: open.ts): the store flushes the log
 * itself, off the loop, on Node's thread pool (Node's fsync, F_FULLFSYNC on macOS, which flushes
 * the drive's cache too), one flush at a time, each for every commit made before it began. So the
 * drive's flush, milliseconds at best and far more while other programs write, never waits on the
 * loop while the store is open, and one flush covers every commit made while the last went on.
 * The commit's own writes into the log do run on the loop: into the system's cache, which is
 * quick, but which the system holds back while other programs fill it, as heavy writing to the
 * same drive does (Core Database §4, G2: e2e/load.e2e.ts holds the loop within its budget on a
 * quiet drive, and only a connection on a thread of its own would under such writing).
 *
 * SQLite checkpoints nothing by itself (wal_autocheckpoint is off: its checkpoints would land in
 * the middle of a commit): the store checkpoints its log into the database once it is idle, off the
 * loop, on a thread of its own (checkpointer.ts: PASSIVE, which also begins the log anew there once
 * it copied all of it, since beginning it syncs), committing nothing meanwhile, so that writes
 * queued wait for it rather than either connection failing for the other; it truncates the log as
 * it closes (on the loop, as it opens: neither while it serves).
 *
 * It takes a snapshot of itself (snapshots.ts) as it closes, and every SNAPSHOT_EVERY_MS once
 * idle after writes: the first as soon as it is, if the profile has none.
 */

/** What the store's timers, snapshots' times and log's flushes run on: in tests, by the test's hand. */
export interface StoreDeps {
  /** Runs `run` after `ms`; returns what cancels it. */
  later: (run: () => void, ms: number) => () => void;
  /** The time, in epoch ms. */
  now: () => number;
  /** Flushes what was written to the file `fd` is open on to the drive, off the loop. */
  flush: (fd: number) => Promise<void>;
}

/**
 * The real clock, and Node's fsync on its thread pool. A checkpoint's timer keeps no process
 * running: the log is on disk already.
 */
export const SYSTEM_DEPS: StoreDeps = {
  later: (run, ms) => {
    const timer = setTimeout(run, ms).unref();
    return () => {
      clearTimeout(timer);
    };
  },
  now: () => Date.now(),
  flush: (fd) =>
    new Promise((resolve, reject) => {
      fsync(fd, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
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

/** A commit whose log isn't flushed yet: what settles the writes it held. */
interface Unflushed {
  resolve: () => void;
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
  /** The log's file, open to flush it, once a commit has made it. */
  #log: number | undefined;
  /** The commits made since the flush going on began, in order. */
  #unflushed: Unflushed[] = [];
  /** The flush going on, if one is. */
  #flushing: Promise<void> | undefined;
  readonly #checkpointer: Checkpointer;
  /** The checkpoint going on, if one is: the lane commits nothing meanwhile. */
  #checkpointing: Promise<void> | undefined;

  constructor(connection: Connection, { profile, file, deps, snapshotAt }: Opening) {
    this.#connection = connection;
    this.#profile = profile;
    this.file = file;
    this.#deps = deps;
    this.#snapshotAt = snapshotAt;
    this.#checkpointer = new Checkpointer(file);
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
   * one, as a savepoint (transaction.ts). Synchronous: what it did is on disk once it returns, its
   * log flushed on the loop. Refused once the store is closing, but within a write it commits.
   */
  tx<T>(run: () => T): T {
    const outermost = !this.#connection.isTransaction;
    if (outermost && this.#shut) throw closed();
    const value = transaction(this.#connection, run);
    if (outermost) {
      fsyncSync(this.#logFile());
      this.#committed();
    }
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
   * Checkpoints the log into the database now, off the loop (one at a time: asked for while one
   * goes on, it is that one), beginning it anew there if it copied all of it. The writes queued
   * meanwhile commit once it is done. Resolves once it is done; rejects if it couldn't be.
   */
  checkpoint(): Promise<void> {
    if (this.#checkpointing !== undefined) return this.#checkpointing;
    const checkpointing = this.#checkpointer.checkpoint().then(
      () => undefined,
      (error: unknown) => {
        throw new Error(`Could not checkpoint the core’s database: ${reason(error)}`, {
          cause: error,
        });
      },
    );
    this.#checkpointing = checkpointing;
    void checkpointing
      .catch(() => undefined)
      .then(() => {
        if (this.#checkpointing === checkpointing) this.#checkpointing = undefined;
        this.#flush();
      });
    return checkpointing;
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
    this.#cancelCheckpoint?.();
    // The writes queued commit now, or once the checkpoint going on is done.
    while (this.#checkpointing !== undefined) await this.#checkpointing.catch(() => undefined);
    this.#flush();
    while (this.#flushing !== undefined) await this.#flushing;
    await this.#checkpointer.close();
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
    if (this.#log !== undefined) closeSync(this.#log);
  }

  /** Commits every write queued, a batch at a time, unless a checkpoint goes on. */
  #flush(): void {
    if (this.#checkpointing !== undefined) return;
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
    this.#unflushed.push({
      resolve: () => {
        for (const [write, value] of done) write.resolve(value);
      },
      reject: (error) => {
        for (const [write] of done) write.reject(error);
      },
    });
    this.#flushLog();
    this.#committed();
    return [];
  }

  /**
   * Flushes the log to the drive, off the loop, for every commit made since the last flush began:
   * one flush at a time, the commits made meanwhile settled by the next. A flush that fails rejects
   * the writes of the commits it was for.
   */
  #flushLog(): void {
    if (this.#flushing !== undefined || this.#unflushed.length === 0) return;
    const commits = this.#unflushed;
    this.#unflushed = [];
    const flushing = (async () => {
      try {
        await this.#deps.flush(this.#logFile());
        for (const commit of commits) commit.resolve();
      } catch (error) {
        for (const commit of commits) commit.reject(error);
      }
    })();
    this.#flushing = flushing;
    void flushing.then(() => {
      this.#flushing = undefined;
      this.#flushLog();
    });
  }

  /** The log's file, open to flush it: SQLite makes it with the first commit. */
  #logFile(): number {
    this.#log ??= openSync(`${this.file}-wal`, 'r+');
    return this.#log;
  }

  /**
   * Sets the checkpoint due once the store is idle, or at most so long after the first commit: none
   * once it is closing, which checkpoints as it closes.
   */
  #committed(): void {
    if (this.#shut) return;
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

  /** Once idle: checkpoints the log, off the loop, and takes the snapshot due, if one is. */
  #checkpoint(): void {
    this.#cancelCheckpoint = undefined;
    this.#uncheckpointedSince = undefined;
    this.checkpoint().catch((error: unknown) => {
      console.error(error);
    });
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
