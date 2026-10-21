import { closeSync, fsync, fsyncSync, ftruncateSync, openSync } from 'node:fs';

import { Checkpointer } from './checkpointer';
import { discardSnapshots, takeSnapshot } from './snapshots';
import { connect } from './sqlite';
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
 * means. A commit that fails rejects every write it held, and the writes after it are a batch of
 * their own. A commit runs on the loop (node:sqlite is synchronous), but SQLite syncs nothing as
 * it commits (synchronous NORMAL: open.ts): the store flushes the log itself, off the loop, on
 * Node's thread pool (Node's fsync, F_FULLFSYNC on macOS, which flushes the drive's cache too),
 * one flush at a time, each for every commit made before it began. So the drive's flush,
 * milliseconds at best and far more while other programs write, never waits on the loop while the
 * store is open, and one flush covers every commit made while the last went on. The commit's own
 * writes into the log do run on the loop: into the system's cache, which is quick, but which the
 * system holds back while other programs fill it, as heavy writing to the same drive does (Core
 * Database §4, G2: e2e/load.e2e.ts holds the loop within its budget on a quiet drive, and only a
 * connection on a thread of its own would under such writing).
 *
 * A flush that fails fails the store closed: nothing written after it could be trusted to reach
 * the drive (after a failed fsync, the system's cache of the file can't be: PostgreSQL's fsyncgate).
 * Every write and read from then on is refused, saying why, as an unopened store's are, until the
 * core opens the database again; it says so once on stderr. What it had committed since its last flush that
 * worked (the failed flush's commits and those made since) is taken back: its log is cut back to
 * where they began, which SQLite says before each commit (`wal_checkpoint(NOOP)`, SQLite 3.51 and
 * later), and closed without SQLite checkpointing it, so the next open recovers the log up to
 * there alone. The cut is best effort: if cutting or syncing it fails, a write whose flush failed
 * may return after a restart, in doubt as in PostgreSQL and SQLite; it says so on stderr. Every
 * snapshot published since the first rejected commit is removed. A checkpoint waits
 * for the flushes going on (the lane commits nothing meanwhile), so none ever copies a commit
 * into the database before its flush worked.
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
/** The longest between checkpoints, except while a snapshot occupies the worker. */
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

/** A commit whose log isn't flushed yet: what settles the writes it held, and where it began. */
interface Unflushed {
  resolve: () => void;
  reject: (error: unknown) => void;
  /** The frames the log held before it: what a failed flush cuts the log back to. */
  frames: number;
  /** Which commit of the store's it was (counted from 1). */
  commit: number;
}

/** A log's header, and the header of each frame in it, before its page (sqlite.org/fileformat2). */
const LOG_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;

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
  /** The commits the flush going on is for. */
  #inFlush: Unflushed[] = [];
  /** The flush going on, if one is. */
  #flushing: Promise<void> | undefined;
  /** How many commits the store has made. */
  #commits = 0;
  /** The snapshots it took, each with how many commits it had made once it was taken. */
  #taken: { file: string; commits: number }[] = [];
  /** Why it failed closed (a flush of its log failed), once it has: every write and read refused. */
  #failed: Error | undefined;
  /** Taking back what it hadn't flushed when it failed, then closing its connection. */
  #forgetting: Promise<void> | undefined;
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
    if (this.#failed !== undefined) throw this.#failed;
    return this.#prepare(sql);
  }

  #prepare(sql: string): Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#connection.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Runs SQL without parameters (statements separated by semicolons). */
  exec(sql: string): void {
    if (this.#failed !== undefined) throw this.#failed;
    this.#connection.exec(sql);
  }

  /**
   * Runs `run` in a transaction, committed once it returns, and returns what it returned; within
   * one, as a savepoint (transaction.ts). Synchronous: what it did is on disk once it returns, its
   * log flushed on the loop (a flush that fails failing the store closed). Refused once the store
   * is closing, but within a write it commits, and once it failed closed.
   */
  tx<T>(run: () => T): T {
    if (this.#failed !== undefined) throw this.#failed;
    const outermost = !this.#connection.isTransaction;
    if (!outermost) return transaction(this.#connection, run);
    if (
      this.#inFlush.length > 0 ||
      this.#unflushed.length > 0 ||
      this.#checkpointing !== undefined
    ) {
      throw new Error(
        'A synchronous transaction cannot overlap the store’s write lane or checkpoint.',
      );
    }
    if (this.#shut) throw closed();
    const frames = this.#frames();
    const commit = ++this.#commits;
    const value = transaction(this.#connection, run);
    try {
      fsyncSync(this.#logFile());
    } catch (error) {
      throw this.#fail(error, { frames, commit });
    }
    this.#committed();
    return value;
  }

  /**
   * Queues `run` (synchronous, with no await inside) for the lane's next commit, with the other
   * writes queued in this turn of the loop. Resolves with what it returned once that commit has
   * returned; rejects, keeping nothing of it, if it threw or the commit failed. Refused once the
   * store is closing.
   */
  write<T>(run: () => T): Promise<T> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
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
   * goes on, it is that one), once every commit made is flushed, beginning it anew there if it
   * copied all of it. The writes queued meanwhile commit once it is done. Resolves once it is done;
   * rejects if it couldn't be, or a flush it waited for failed.
   */
  checkpoint(): Promise<void> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#checkpointing !== undefined) return this.#checkpointing;
    const checkpointing = (async () => {
      // Only what is on the drive is copied into the database.
      while (this.#flushing !== undefined) await this.#flushing;
      if (this.#failed !== undefined) throw this.#failed;
      try {
        await this.#checkpointer.checkpoint();
      } catch (error) {
        throw new Error(`Could not checkpoint the core’s database: ${reason(error)}`, {
          cause: error,
        });
      }
    })();
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
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#snapshotting !== undefined) return this.#snapshotting;
    const at = this.#deps.now();
    const taking = takeSnapshot(
      this.file,
      this.#profile,
      at,
      (file) => {
        if (this.#failed !== undefined) throw this.#failed;
        this.#taken.push({ file, commits: this.#commits });
      },
      this.#checkpointer,
    )
      .then((file) => {
        // Failure can arrive while place() awaits its rename/directory sync. Cleanup still tracks
        // that file, but no caller may receive it as a successful snapshot of a failed store.
        if (this.#failed !== undefined) throw this.#failed;
        return file;
      })
      .finally(() => {
        this.#snapshotting = undefined;
      });
    this.#snapshotting = taking;
    this.#snapshotAt = at;
    return taking;
  }

  /**
   * Closes the database once the writes queued so far are committed, checkpointing its log into it
   * and taking a snapshot of it (neither once it failed closed). Writes asked for meanwhile are
   * refused. Closing it again does nothing more.
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
    // Failed closed, it took back what it hadn't flushed, and closed its connection then.
    if (this.#forgetting !== undefined) {
      await this.#forgetting;
      return;
    }
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
    await this.#checkpointer.close();
    this.#connection.close();
    if (this.#log !== undefined) closeSync(this.#log);
  }

  /** Commits every write queued, a batch at a time, unless a checkpoint goes on. */
  #flush(): void {
    if (this.#checkpointing !== undefined) return;
    let batch = this.#queue;
    this.#queue = [];
    while (batch.length > 0) {
      if (this.#failed !== undefined) {
        for (const write of batch) write.reject(this.#failed);
        return;
      }
      batch = this.#commit(batch);
    }
  }

  /** Commits a batch of writes in one transaction; returns those it didn't run. */
  #commit(batch: Queued[]): Queued[] {
    let frames: number;
    try {
      frames = this.#frames();
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
      frames,
      commit: ++this.#commits,
    });
    this.#flushLog();
    this.#committed();
    return [];
  }

  /**
   * Flushes the log to the drive, off the loop, for every commit made since the last flush began:
   * one flush at a time, the commits made meanwhile settled by the next. A flush that fails fails
   * the store closed (`#fail`).
   */
  #flushLog(): void {
    if (this.#flushing !== undefined || this.#unflushed.length === 0) return;
    if (this.#failed !== undefined) return;
    const commits = this.#unflushed;
    this.#unflushed = [];
    this.#inFlush = commits;
    const flushing = (async () => {
      try {
        await this.#deps.flush(this.#logFile());
      } catch (error) {
        this.#fail(error);
        return;
      }
      this.#inFlush = [];
      // Failed meanwhile (a `tx`'s flush), it took these back too.
      if (this.#failed !== undefined) return;
      for (const commit of commits) commit.resolve();
    })();
    this.#flushing = flushing;
    void flushing.then(() => {
      this.#flushing = undefined;
      this.#flushLog();
    });
  }

  /** How many frames the log holds now, as SQLite says without checkpointing any. */
  #frames(): number {
    const log = this.#prepare('PRAGMA wal_checkpoint(NOOP)').get()?.log;
    if (typeof log !== 'number' || !Number.isInteger(log) || log < 0) {
      throw new Error('SQLite did not say how long the core’s database’s log is.');
    }
    return log;
  }

  /**
   * Fails the store closed, a flush of its log having failed (`error`): every commit not flushed
   * yet rejected (`also`, a `tx`'s, with them), every write queued and every one after refused,
   * saying why, and said once on stderr; then what they wrote taken back (`#forget`). Returns why.
   */
  #fail(error: unknown, also?: { frames: number; commit: number }): Error {
    if (this.#failed !== undefined) return this.#failed;
    const failed = new Error(
      `The core’s database could not be written to the drive (${reason(error)}), so it keeps nothing more until the core opens it again: what it wrote since it was last on the drive could not be confirmed.`,
      { cause: error },
    );
    this.#failed = failed;
    console.error(failed.message);
    this.#cancelCheckpoint?.();
    this.#cancelCheckpoint = undefined;
    const lost = [...this.#inFlush, ...this.#unflushed];
    this.#inFlush = [];
    this.#unflushed = [];
    const queued = this.#queue;
    this.#queue = [];
    for (const write of queued) write.reject(failed);
    const first = [...lost, ...(also === undefined ? [] : [also])].reduce((earliest, commit) =>
      commit.commit < earliest.commit ? commit : earliest,
    );
    this.#forgetting = this.#forget(first).finally(() => {
      // Refuse new work at once, and finish the best-effort rollback before rejecting commits.
      for (const commit of lost) commit.reject(failed);
    });
    void this.#forgetting.catch((error: unknown) => {
      console.error('Could not finish closing the core’s database after its failed flush:', error);
    });
    return failed;
  }

  /**
   * Takes back, off the drive, what the store committed from `first` on: its log cut back to the
   * frames before it, then its connection closed without SQLite checkpointing the log (another
   * connection, which only reads, holds the database meanwhile; one closing that only reads never
   * checkpoints), so the next open recovers the log up to there alone; and every snapshot taken
   * since it, which may hold it, removed. Once the flush and the snapshot going on have ended, and
   * the checkpointer's connection is closed: nothing else in the process keeps the log's index.
   */
  async #forget(first: { frames: number; commit: number }): Promise<void> {
    while (this.#flushing !== undefined) await this.#flushing;
    await this.#snapshotting?.catch(() => undefined);
    await this.#checkpointer.close();
    const unsafe = this.#taken
      .filter(({ commits }) => commits >= first.commit)
      .map(({ file }) => file);
    try {
      await discardSnapshots(this.#profile, unsafe);
    } catch (error) {
      console.error('Could not remove snapshots of what the core’s database lost:', error);
    }
    try {
      const page = this.#prepare('PRAGMA page_size').get()?.page_size as number;
      const log = this.#logFile();
      // Best effort: if this cut or its fsync fails, the failed commit is in doubt across a
      // restart, as in PostgreSQL and SQLite. No recovery marker is kept to change that limit.
      ftruncateSync(
        log,
        first.frames === 0 ? 0 : LOG_HEADER_BYTES + first.frames * (FRAME_HEADER_BYTES + page),
      );
      fsyncSync(log);
    } catch (error) {
      console.error(
        'Could not take back the core’s unflushed writes; a write whose flush failed may come back after a restart, in doubt as in PostgreSQL and SQLite:',
        error,
      );
    }
    let holder: Connection | undefined;
    try {
      holder = connect(this.file, { readOnly: true, timeout: 0 });
      holder.prepare('SELECT count(*) FROM sqlite_schema').get();
    } catch {
      // Closing alone, the connection checkpoints what the log holds now: up to the cut alone.
      holder?.close();
      holder = undefined;
    }
    try {
      this.#connection.close();
    } finally {
      holder?.close();
    }
    if (this.#log !== undefined) closeSync(this.#log);
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
    if (this.#shut || this.#failed !== undefined) return;
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
    if (this.#failed !== undefined) return;
    // A synchronous scan on the shared worker cannot take a checkpoint job meanwhile. Do not
    // hold the write lane waiting behind that scan; try maintenance again once idle later.
    if (this.#snapshotting !== undefined) {
      this.#cancelCheckpoint = this.#deps.later(() => {
        this.#checkpoint();
      }, CHECKPOINT_IDLE_MS);
      return;
    }
    this.#uncheckpointedSince = undefined;
    this.checkpoint().catch((error: unknown) => {
      // Failing closed is said once, as it fails.
      if (error !== this.#failed) console.error(error);
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
