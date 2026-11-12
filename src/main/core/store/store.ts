import { closeSync, fsync, fsyncSync, ftruncateSync, openSync } from 'node:fs';

import type { Worker } from 'node:worker_threads';

import { Checkpointer } from './checkpointer';
import { discardSnapshots, takeSnapshot } from './snapshots';
import { connect } from './sqlite';
import type { Connection, SqlOutput, Statement } from './sqlite';
import { rollback, savepoint, transaction } from './transaction';
import type { Hold, Outcome, Sync, Writer } from './writer';

/*
 * The core's database (Core Database §4, §5), open: one connection to <profile>/core.db, which only
 * the core writes (it holds core.lock). openStore (open.ts) opens it.
 *
 * Writes go through one FIFO lane (group commit), each in a savepoint of its own, so one that
 * fails rolls back only itself and rejects only its caller. A transaction stops between writes
 * after 32 changed rows or 16 writes; one atomic write is never split. Each resolves with what its function returned only once the commit
 * that holds it has returned and the log it was written to has been flushed to the drive: a write
 * is on disk when its promise resolves, which is what "its record on disk before it is sent"
 * means. A commit that fails rejects every write it held, and the writes after it are a batch of
 * their own. A commit runs on the loop (node:sqlite is synchronous), but SQLite syncs nothing as
 * it commits (synchronous NORMAL: open.ts): the store flushes the log itself, off the loop, on
 * Node's thread pool (Node's fsync, F_FULLFSYNC on macOS, which flushes the drive's cache too),
 * one flush at a time. The lane waits for it before appending again, so native WAL writes do not
 * contend with our own flush; queued writes keep their order and take the next bounded commit.
 * The drive's flush, milliseconds at best and far more while other programs write, never waits
 * on the loop while the store is open. The commit's own
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
  /**
   * Test seam for the writer's thread: while `hold[0]` is 1 the writer waits, before each statement
   * of a planned write, adding 1 to `hold[1]` as it arrives; set `hold[0]` to 0 and notify it to release.
   */
  hold?: Hold;
  /** Test seam: gets the writer's thread as it starts (a test ends it to lose the writer). */
  writerStarted?: (worker: Worker) => void;
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
/** Bound aggregation between atomic writes; an individual write is never split. */
const COMMIT_ROWS = 32;
const COMMIT_WRITES = 16;
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
  /**
   * The writer's thread, if the store hands writing to it (open.ts): the connection given then
   * only reads. Otherwise the connection writes, on the loop (the local executor).
   */
  writer?: Writer | undefined;
}

/** What a statement of a write binds: SQLite's input values. */
export type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
/** A row a statement gave back. */
export type Row = Record<string, SqlOutput>;

/** A statement of a planned write, kept until the write's plan has run. */
interface Step {
  sql: string;
  params: readonly SqlValue[];
  /** Fail the write with `error` unless the statement changed exactly `changes` rows. */
  expect?: { changes: number; error: string };
  /** Gets the rows the statement gave back (RETURNING), once the write's statements have run. */
  then?: (rows: Row[]) => void;
}

/**
 * The write whose function is running (`Store.#current`): what `run`, `runExpecting`, `runReturning`,
 * `undo` and `followUp` act on.
 *  - `planned`: the function only plans: its statements are kept (`steps`) and run in the write's
 *    savepoint once it has returned.
 *  - `blocking`: its statements run at once, as the function runs.
 *  - `tx`: as blocking, in a `tx`.
 */
class WriteContext {
  readonly steps: Step[] = [];
  readonly followUps: (() => void)[] = [];
  readonly #undos: (() => void)[] = [];

  readonly kind: 'planned' | 'blocking' | 'tx';

  constructor(kind: 'planned' | 'blocking' | 'tx') {
    this.kind = kind;
  }

  get planned(): boolean {
    return this.kind === 'planned';
  }

  undo(restore: () => void): void {
    this.#undos.push(restore);
  }

  /** Restores memory as the write failed: its hooks, newest first, each once. */
  restore(): void {
    for (const restore of this.#undos.splice(0).reverse()) restore();
  }
}

/** A write waiting in the lane. */
interface Queued {
  run: () => unknown;
  /** Whether `run` plans (`Store.write`) rather than reads as it runs (`Store.writeBlocking`). */
  planned: boolean;
  /** Whether it is another write's follow-up, run right after it whatever the bounds. */
  followUp?: true;
  /** Its context, once its function has run. */
  context?: WriteContext;
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
  readonly #facades = new Map<string, Statement>();
  /** The writes waiting for the lane's next commit, in order. */
  #queue: Queued[] = [];
  #scheduled = false;
  /** The write whose function is running, if one is. */
  #current: WriteContext | undefined;
  #returning = false;
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
  /** The writer's thread, if there is one: the one connection that writes. */
  readonly #writer: Writer | undefined;
  /** The lane's commit going on (its writes planned and run one at a time), if one is. */
  #draining: Promise<void> | undefined;
  /** The current transaction's cut-back point, including while its commit reply is in flight. */
  #active: { frames: number; commit: number } | undefined;
  /** The checkpoint going on, if one is: the lane commits nothing meanwhile. */
  #checkpointing: Promise<void> | undefined;

  constructor(connection: Connection, { profile, file, deps, snapshotAt, writer }: Opening) {
    this.#connection = connection;
    this.#profile = profile;
    this.file = file;
    this.#deps = deps;
    this.#snapshotAt = snapshotAt;
    this.#checkpointer = new Checkpointer(file);
    this.#writer = writer;
    // A thread that ends while the store is open is a failed flush: nothing it wrote can be trusted.
    writer?.onLost((error) => {
      this.#fail(error);
    });
  }

  /**
   * A statement, prepared once for its SQL: SQL with parameters for its values, never the values
   * themselves, or each would be kept apart.
   */
  prepare(sql: string): Statement {
    this.#sqlAllowed();
    if (this.#failed !== undefined) throw this.#failed;
    if (this.#current?.planned === true) {
      throw new Error(
        'A planned write reads no SQL: it reads memory and gives statements (run, runExpecting, runReturning). A function that must read as it runs is a blocking write.',
      );
    }
    return this.#statement(sql);
  }

  /**
   * A statement for a read or a write's own statement: through the writer within a blocking write
   * or a `tx` (it sees the write), else on this connection.
   */
  #statement(sql: string): Statement {
    const writer = this.#writer;
    if (writer === undefined || this.#current === undefined) this.#prepare(sql);
    const kept = this.#facades.get(sql);
    if (kept !== undefined) return kept;
    let readBigInts = false;
    const inside = (): boolean => {
      this.#sqlAllowed();
      if (this.#failed !== undefined) throw this.#failed;
      if (this.#current?.planned === true) throw new Error('A planned write reads no SQL.');
      return this.#current !== undefined;
    };
    const reading = (): Statement => {
      const statement = this.#prepare(sql);
      statement.setReadBigInts(readBigInts);
      return statement;
    };
    const statement = {
      get: (...params: SqlValue[]) =>
        inside() && writer !== undefined
          ? writer.sync({ op: 'get', sql, params, readBigInts }).row
          : reading().get(...params),
      all: (...params: SqlValue[]) =>
        inside() && writer !== undefined
          ? (writer.sync({ op: 'all', sql, params, readBigInts }).rows ?? [])
          : reading().all(...params),
      run: (...params: SqlValue[]) => {
        if (!inside() || writer === undefined) return reading().run(...params);
        const result = writer.sync({ op: 'run', sql, params, readBigInts });
        return { changes: result.changes ?? 0, lastInsertRowid: result.lastInsertRowid ?? 0 };
      },
      setReadBigInts: (enabled: boolean) => {
        readBigInts = enabled;
      },
    } as unknown as Statement;
    this.#facades.set(sql, statement);
    return statement;
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
    this.#sqlAllowed();
    if (this.#failed !== undefined) throw this.#failed;
    if (this.#current?.planned === true)
      throw new Error('A planned write runs no SQL but its own.');
    if (this.#current === undefined) {
      this.tx(() => {
        this.exec(sql);
      });
      return;
    }
    if (this.#writer === undefined) this.#connection.exec(sql);
    else this.#writer.sync({ op: 'exec', sql });
  }

  /**
   * Runs `run` in a transaction, committed once it returns, and returns what it returned; within
   * one, as a savepoint (transaction.ts). Synchronous: what it did is on disk once it returns, its
   * log flushed on the loop (a flush that fails failing the store closed). Refused once the store
   * is closing, but within a write it commits, and once it failed closed. Test callers must be
   * quiescent; live work uses write or writeBlocking, which wait their turn in the lane.
   */
  tx<T>(run: () => T): T {
    this.#sqlAllowed();
    if (this.#failed !== undefined) throw this.#failed;
    const writer = this.#writer;
    const outermost =
      writer === undefined ? !this.#connection.isTransaction : this.#current === undefined;
    if (this.#current?.planned === true) throw new Error('A planned write starts no transaction.');
    if (!outermost) {
      const outer = this.#current;
      const { value, context } = this.#transaction(run, false);
      outer?.undo(() => {
        context.restore();
      });
      return value;
    }
    if (
      this.#inFlush.length > 0 ||
      this.#unflushed.length > 0 ||
      this.#checkpointing !== undefined ||
      this.#draining !== undefined
    ) {
      throw new Error(
        'A synchronous transaction cannot overlap the store’s write lane or checkpoint. Queue it with writeBlocking instead.',
      );
    }
    if (this.#shut) throw closed();
    const frames = writer === undefined ? this.#frames() : this.#begin(writer);
    const commit = ++this.#commits;
    if (writer !== undefined) this.#active = { frames, commit };
    let transaction: { value: T; context: WriteContext };
    try {
      transaction = this.#transaction(run, true);
    } catch (error) {
      this.#active = undefined;
      throw error;
    }
    const { value, context } = transaction;
    try {
      fsyncSync(this.#logFile());
    } catch (error) {
      context.restore();
      throw this.#fail(error, { frames, commit });
    }
    this.#active = undefined;
    this.#committed();
    return value;
  }

  /** Begins the writer's transaction; the frames the log held before it. */
  #begin(writer: Writer): number {
    return framesOf(writer.sync({ op: 'begin' }).frames);
  }

  /**
   * A synchronous transaction's hooks belong to its own savepoint, not the containing write.
   * Through the writer, `outermost` has begun already (`#begin`) and this commits.
   */
  #transaction<T>(run: () => T, outermost: boolean): { value: T; context: WriteContext } {
    const context = new WriteContext('tx');
    const inside = (): T => {
      const value = this.#within(context, run);
      for (
        let next = context.followUps.shift();
        next !== undefined;
        next = context.followUps.shift()
      )
        this.#within(context, next);
      return value;
    };
    try {
      const writer = this.#writer;
      if (writer === undefined) return { value: transaction(this.#connection, inside), context };
      return { value: this.#writerTransaction(writer, outermost, inside), context };
    } catch (error) {
      context.restore();
      throw error;
    }
  }

  /** `inside` in the writer's transaction: committed once it returns, else as a savepoint. */
  #writerTransaction<T>(writer: Writer, outermost: boolean, inside: () => T): T {
    const undo = (op: 'rollback' | 'rollbackTo'): void => {
      try {
        writer.sync({ op });
      } catch {
        // The error that made the rollback is the one to throw.
      }
    };
    if (!outermost) writer.sync({ op: 'savepoint' });
    try {
      const value = synchronously(inside());
      writer.sync({ op: outermost ? 'commit' : 'release' });
      return value;
    } catch (error) {
      undo(outermost ? 'rollback' : 'rollbackTo');
      throw error;
    }
  }

  /**
   * Queues a planned write for the FIFO lane's next bounded commit. `plan` is synchronous (no await
   * inside) and runs at the lane's turn, on the loop. It reads memory only (`prepare` throws within
   * it) and gives its statements with `run`, `runExpecting` and `runReturning`, which run in a
   * savepoint of the write's own once it has returned. Resolves with what `plan` returned once the
   * commit that holds it has returned and its log is flushed; rejects, keeping nothing of it, if it
   * threw, a statement failed, or the commit or flush did. Refused once the store is closing.
   * What the plan staged in memory is restored on rejection, before the next write is planned:
   * by the hooks it gave `undo` (newest first), then by `failed`, which must not throw.
   */
  write<T>(plan: () => T, failed?: (error: unknown) => void): Promise<T> {
    return this.#enqueue(true, plan, failed);
  }

  /**
   * Queues a write whose function needs SQL as it runs (compare-and-set, reading its own earlier
   * statements): `run` is synchronous too, and reads and writes through `prepare`, or `run`,
   * `runExpecting` and `runReturning`, which act at once. Otherwise as `write`. Pinned, file by
   * file (blocking.test.ts): a write that reads nothing is planned.
   */
  writeBlocking<T>(run: () => T, failed?: (error: unknown) => void): Promise<T> {
    return this.#enqueue(false, run, failed);
  }

  #enqueue<T>(planned: boolean, run: () => T, failed?: (error: unknown) => void): Promise<T> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#shut) return Promise.reject(closed());
    return new Promise<T>((resolve, reject) => {
      const queued: Queued = {
        run,
        planned,
        resolve: resolve as (value: unknown) => void,
        reject: (error) => {
          queued.context?.restore();
          failed?.(error);
          // Preserve the containing write's original rejection after restoring its staging.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        },
      };
      this.#queue.push(queued);
      this.#schedule();
    });
  }

  /**
   * Within a write: a statement of it. In a planned write, kept and run in the write's savepoint,
   * after those before it; in a blocking write or a `tx`, run at once.
   */
  run(sql: string, ...params: SqlValue[]): void {
    this.#step({ sql, params });
  }

  /**
   * Within a write: as `run`, failing the write with `error` unless the statement changed exactly
   * `changes` rows.
   */
  runExpecting(sql: string, params: readonly SqlValue[], changes: number, error: string): void {
    this.#step({ sql, params, expect: { changes, error } });
  }

  /**
   * Within a write: as `run`, giving `then` the rows the statement returned (RETURNING), on the
   * loop, once the write's statements have run: in a planned write before the next write is
   * planned and before this one resolves. A result callback reads memory and its rows only;
   * prepare (including cached statements), exec, tx and statement methods are refused in it.
   */
  runReturning(sql: string, params: readonly SqlValue[], then: (rows: Row[]) => void): void {
    this.#step({ sql, params, then });
  }

  /**
   * Within a write: restores memory if the write fails (its plan, a statement, the commit, the
   * flush), newest hook first, before the next write is planned. Must not throw.
   */
  undo(restore: () => void): void {
    this.#context('undo').undo(restore);
  }

  /**
   * Within a write: `run` as a blocking write right after this one, in the same commit, whatever
   * the commit's bounds. It fails alone, said on stderr, its write kept.
   */
  followUp(run: () => void): void {
    const context = this.#context('followUp');
    context.followUps.push(run);
  }

  #context(what: string): WriteContext {
    if (this.#current === undefined) throw new Error(`${what} is only available within a write.`);
    return this.#current;
  }

  #step(step: Step): void {
    this.#sqlAllowed();
    const context = this.#context('A statement');
    if (context.planned) {
      context.steps.push(step);
    } else {
      const result = execute(this.#statement(step.sql), step);
      if (result !== undefined) this.#result(result);
    }
  }

  #sqlAllowed(): void {
    if (this.#returning)
      throw new Error('A result callback reads memory and returned rows only, and runs no SQL.');
  }

  /** Result callbacks have no SQL connection: both executors expose only memory and their rows. */
  #result(run: () => void): void {
    const outer = this.#returning;
    this.#returning = true;
    try {
      run();
    } finally {
      this.#returning = outer;
    }
  }

  /** Runs `run` with `context` as the write going on. */
  #within<T>(context: WriteContext, run: () => T): T {
    const outer = this.#current;
    this.#current = context;
    try {
      return run();
    } finally {
      this.#current = outer;
    }
  }

  /**
   * Runs a write's function in a savepoint of its own and, if it planned, its statements right
   * after (the local executor): on an error, all of it is rolled back. Returns what the function
   * returned. The rows `runReturning` asked for reach their callbacks before the savepoint ends,
   * so one that throws fails the write.
   */
  #execute(write: Queued): unknown {
    const context = new WriteContext(write.planned ? 'planned' : 'blocking');
    write.context = context;
    return savepoint(this.#connection, () => {
      const value = this.#within(context, write.run);
      const delivered: (() => void)[] = [];
      for (const step of context.steps) {
        const deliver = execute(this.#prepare(step.sql), step);
        if (deliver !== undefined) delivered.push(deliver);
      }
      for (const deliver of delivered) this.#result(deliver);
      return value;
    });
  }

  /**
   * Checkpoints the log into the database now, off the loop (one at a time: asked for while one
   * goes on, it is that one), once every commit made is flushed, beginning it anew there if it
   * copied all of it. The writes queued meanwhile commit once it is done. Resolves once it is done;
   * rejects if it couldn't be, or a flush it waited for failed.
   */
  checkpoint(): Promise<void> {
    return this.#checkpointNow(false);
  }

  #checkpointNow(idle: boolean): Promise<void> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (this.#checkpointing !== undefined) return this.#checkpointing;
    const checkpointing = (async () => {
      // Only what is on the drive is copied into the database, and the checkpointer's beginning of
      // the log must never meet a write transaction that is open (SQLITE_BUSY, with no timeout).
      for (let busy = this.#draining ?? this.#flushing; busy !== undefined;) {
        await busy;
        busy = this.#draining ?? this.#flushing;
      }
      if (this.#failed !== undefined) throw this.#failed;
      try {
        const done = await this.#checkpointer.checkpoint();
        // A queued write always takes priority. Once begun, a vacuum pass holds the lane for
        // at most VACUUM_PAGES pages; subsequent passes must wait for another idle interval.
        if (idle && this.#canVacuum() && done.log === done.checkpointed) {
          const remaining = await this.#checkpointer.vacuum();
          if (remaining > 0 && this.#canVacuum()) {
            this.#cancelCheckpoint?.();
            this.#cancelCheckpoint = this.#deps.later(() => {
              this.#checkpoint();
            }, CHECKPOINT_IDLE_MS);
          }
        }
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

  #canVacuum(): boolean {
    return (
      !this.#shut &&
      this.#failed === undefined &&
      this.#queue.length === 0 &&
      this.#snapshotting === undefined
    );
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
        // A backup can see COMMIT before its reply reaches this thread.
        this.#taken.push({ file, commits: Math.max(this.#commits, this.#active?.commit ?? 0) });
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
    while (this.#queue.length > 0 || this.#flushing !== undefined || this.#draining !== undefined) {
      this.#flush();
      const busy = this.#draining ?? this.#flushing;
      if (busy !== undefined) await busy;
    }
    // Failure cleanup owns the connections once it starts, including across closing awaits.
    const failedClose = (): Promise<void> | undefined => this.#forgetting;
    let failure = failedClose();
    if (failure !== undefined) return failure;
    await this.#snapshotting?.catch(() => undefined);
    failure = failedClose();
    if (failure !== undefined) return failure;
    try {
      if (this.#writer === undefined)
        this.#connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      else await this.#writer.truncate();
    } catch (error) {
      console.error('Could not checkpoint the core’s database as it closed:', error);
    }
    failure = failedClose();
    if (failure !== undefined) return failure;
    try {
      await this.snapshot();
    } catch (error) {
      console.error('Could not take a snapshot of the core’s database as it closed:', error);
    }
    failure = failedClose();
    if (failure !== undefined) return failure;
    await this.#checkpointer.close();
    failure = failedClose();
    if (failure !== undefined) return failure;
    this.#connection.close();
    // The writer closes last, so it checkpoints what is left and removes the log and its index.
    await this.#writer?.close();
    if (this.#log !== undefined) closeSync(this.#log);
  }

  /** Schedules the FIFO lane; delivery and publication keep their own microtask ordering. */
  #schedule(): void {
    if (
      this.#scheduled ||
      this.#queue.length === 0 ||
      this.#flushing !== undefined ||
      this.#draining !== undefined
    ) {
      return;
    }
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  /** One bounded commit, with no appends competing with the log's off-loop flush. */
  #flush(): void {
    if (
      this.#checkpointing !== undefined ||
      this.#flushing !== undefined ||
      this.#draining !== undefined
    ) {
      return;
    }
    const batch = this.#queue;
    this.#queue = [];
    if (batch.length === 0) return;
    if (this.#failed !== undefined) {
      for (const write of batch) write.reject(this.#failed);
      return;
    }
    if (this.#writer !== undefined) {
      const writer = this.#writer;
      // Publish the barrier before any plan can synchronously ask for a checkpoint.
      const draining = Promise.resolve()
        .then(() => this.#drain(writer, batch))
        .catch((error: unknown) => {
          console.error('The core’s write lane failed:', error);
          return [];
        })
        .then((remaining) => {
          this.#draining = undefined;
          this.#queue = [...remaining, ...this.#queue];
          this.#schedule();
        });
      this.#draining = draining;
      return;
    }
    const remaining = this.#commit(batch);
    this.#queue = [...remaining, ...this.#queue];
    this.#schedule();
  }

  /** Commits a batch of writes in one transaction; returns those it didn't run. */
  #commit(batch: Queued[]): Queued[] {
    let frames: number;
    try {
      frames = this.#frames();
      this.#connection.exec('BEGIN IMMEDIATE');
    } catch (error) {
      for (const write of [...batch].reverse()) write.reject(error);
      return [];
    }
    const done: [write: Queued, value: unknown][] = [];
    const changed = () => Number(this.#prepare('SELECT total_changes() AS count').get()?.count);
    const start = changed();
    let ran = 0;
    const pending = [...batch];
    for (let write = pending.shift(); write !== undefined; write = pending.shift()) {
      ran++;
      try {
        done.push([write, this.#execute(write)]);
        // Right after it, in the same commit, whatever the bounds.
        pending.unshift(...this.#followUps(write));
      } catch (error) {
        write.reject(error);
        if (!this.#connection.isTransaction) {
          // SQLite rolled the whole transaction back (as on a full disk): what the batch wrote
          // before is gone too, and the writes after it are a batch of their own.
          for (const [lost] of [...done].reverse()) lost.reject(error);
          return pending.filter(({ followUp }) => followUp === undefined);
        }
      }
      if (
        pending[0] !== undefined &&
        pending[0].followUp === undefined &&
        (ran >= COMMIT_WRITES || changed() - start >= COMMIT_ROWS)
      ) {
        break;
      }
    }
    const remaining = pending;
    try {
      this.#connection.exec('COMMIT');
    } catch (error) {
      rollback(this.#connection);
      for (const [lost] of [...done].reverse()) lost.reject(error);
      return remaining;
    }
    this.#unflushed.push({
      resolve: () => {
        for (const [write, value] of done) write.resolve(value);
      },
      reject: (error) => {
        for (const [write] of [...done].reverse()) write.reject(error);
      },
      frames,
      commit: ++this.#commits,
    });
    this.#flushLog();
    this.#committed();
    return remaining;
  }

  /**
   * A bounded commit through the writer's thread: each write is planned (its function run) only once
   * the one before it has been answered, so what a failed write restores is back before the next
   * write reads it. Returns those it didn't run. Never rejects but for a bug: a lost thread
   * (`#fail`) rejects every write it held.
   */
  async #drain(writer: Writer, batch: Queued[]): Promise<Queued[]> {
    const done: [write: Queued, value: unknown][] = [];
    const pending = [...batch];
    let current: Queued | undefined;
    let open = false;
    let frames = 0;
    let ran = 0;
    let changed = 0;
    /** The transaction is gone (SQLite rolled it back, or a callback failed): its writes rejected. */
    const lose = (error: unknown): void => {
      for (const [lost] of [...done].reverse()) lost.reject(error);
      done.length = 0;
      const kept = pending.filter(({ followUp }) => followUp === undefined);
      pending.splice(0, pending.length, ...kept);
      open = false;
      ran = 0;
      changed = 0;
      this.#active = undefined;
    };
    try {
      while (pending.length > 0) {
        if (this.#failed !== undefined) throw this.#failed;
        if (pending[0]?.followUp === undefined && (ran >= COMMIT_WRITES || changed >= COMMIT_ROWS))
          break;
        const write = pending.shift();
        if (write === undefined) break;
        current = write;
        ran++;
        const context = new WriteContext(write.planned ? 'planned' : 'blocking');
        write.context = context;
        let value: unknown;
        let outcome: Outcome;
        if (write.planned) {
          let planned: Outcome | undefined;
          try {
            value = synchronously(this.#within(context, write.run));
          } catch (error) {
            planned = { changes: 0, error, lost: false };
          }
          outcome =
            planned ??
            (await writer.savepoint(
              !open,
              context.steps.map((step) => ({
                sql: step.sql,
                params: step.params,
                expect: step.expect,
                rows: step.then === undefined ? undefined : true,
              })),
              context.steps.some((step) => step.then !== undefined),
            ));
          if (outcome.frames !== undefined) {
            frames = framesOf(outcome.frames);
            open = true;
            this.#active = { frames, commit: this.#commits + 1 };
          }
        } else {
          ({ outcome, value } = this.#blocking(writer, write, context, !open));
          if (outcome.frames !== undefined) {
            frames = framesOf(outcome.frames);
            open = true;
            this.#active = { frames, commit: this.#commits + 1 };
          }
        }
        changed += outcome.changes;
        if ('lost' in outcome) {
          write.reject(outcome.error);
          if (outcome.lost) lose(outcome.error);
        } else {
          let refused: { error: unknown } | undefined;
          try {
            this.#result(() => {
              deliver(context, outcome.rows);
            });
          } catch (error) {
            refused = { error };
          }
          if (write.planned && context.steps.some((step) => step.then !== undefined)) {
            const settled = await writer.settle(refused === undefined);
            if (settled.error !== undefined) refused = { error: settled.error };
            if (refused !== undefined) {
              write.reject(refused.error);
              if (settled.lost === true) lose(refused.error);
              current = undefined;
              continue;
            }
          }
          if (refused !== undefined) {
            write.reject(refused.error);
            current = undefined;
            continue;
          }
          done.push([write, value]);
          // Right after it, in the same commit, whatever the bounds.
          pending.unshift(...this.#followUps(write));
        }
        current = undefined;
      }
      if (!open) return pending;
      let committed: Error | undefined;
      try {
        await writer.commit();
      } catch (error) {
        if (writer.lost !== undefined) throw error;
        committed = error as Error;
      }
      if (committed !== undefined) {
        for (const [lost] of [...done].reverse()) lost.reject(committed);
        this.#active = undefined;
        return pending;
      }
      // The thread was lost as it committed: failed closed, and this commit with it.
      if (this.#failed !== undefined) throw this.#failed;
    } catch (error) {
      const why = this.#failed ?? this.#fail(error);
      current?.reject(why);
      for (const [lost] of [...done].reverse()) lost.reject(why);
      for (const write of pending.splice(0)) write.reject(why);
      return [];
    }
    this.#unflushed.push({
      resolve: () => {
        for (const [write, value] of done) write.resolve(value);
      },
      reject: (error) => {
        for (const [write] of [...done].reverse()) write.reject(error);
      },
      frames,
      commit: ++this.#commits,
    });
    this.#active = undefined;
    this.#flushLog();
    this.#committed();
    return pending;
  }

  /**
   * A blocking write through the writer: its savepoint and each statement run as they are asked
   * for, the loop waiting on them.
   */
  #blocking(
    writer: Writer,
    write: Queued,
    context: WriteContext,
    begin: boolean,
  ): { outcome: Outcome; value: unknown } {
    let frames: number | undefined;
    try {
      if (begin) frames = this.#begin(writer);
      writer.sync({ op: 'savepoint' });
    } catch (error) {
      return { outcome: { ...opened(frames), changes: 0, error, lost: false }, value: undefined };
    }
    try {
      const value = synchronously(this.#within(context, write.run));
      const changes = writer.sync({ op: 'release' }).changes ?? 0;
      return { outcome: { ...opened(frames), changes, rows: [] }, value };
    } catch (error) {
      let changes = 0;
      let lost = true;
      try {
        const undone: Sync = writer.sync({ op: 'rollbackTo' });
        changes = undone.changes ?? 0;
        lost = !undone.tx;
      } catch {
        // The thread is gone: the transaction with it.
      }
      return { outcome: { ...opened(frames), changes, error, lost }, value: undefined };
    }
  }

  /** The follow-ups a write that ran gave, as blocking writes to run right after it. */
  #followUps({ context }: Queued): Queued[] {
    return (context?.followUps ?? []).map((run) => {
      const followUp: Queued = {
        run,
        planned: false,
        followUp: true,
        resolve: () => undefined,
        reject: (error) => {
          followUp.context?.restore();
          console.error('A follow-up write failed:', error);
        },
      };
      return followUp;
    });
  }

  /**
   * Flushes the committed log off the loop. The queued lane appends again only after this flush
   * settles, on its next turn; a failed flush fails the store closed (`#fail`).
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
      this.#schedule();
    });
  }

  /** How many frames the log holds now, as SQLite says without checkpointing any. */
  #frames(): number {
    return framesOf(this.#prepare('PRAGMA wal_checkpoint(NOOP)').get()?.log);
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
    // None to take back if the writer's thread was lost between commits.
    const first = [
      ...lost,
      ...(also === undefined ? [] : [also]),
      ...(this.#active === undefined ? [] : [this.#active]),
    ].reduce<{ frames: number; commit: number } | undefined>(
      (earliest, commit) =>
        earliest === undefined || commit.commit < earliest.commit ? commit : earliest,
      undefined,
    );
    this.#forgetting = this.#forget(first).finally(() => {
      // Refuse new work at once, and finish the best-effort rollback before rejecting commits.
      // Newest first, so each restores memory over what the writes after it staged.
      for (const commit of [...lost].reverse()) commit.reject(failed);
      for (const write of queued.reverse()) write.reject(failed);
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
  async #forget(first: { frames: number; commit: number } | undefined): Promise<void> {
    if (this.#writer?.lost !== undefined) await this.#writer.stop();
    while (this.#flushing !== undefined || this.#draining !== undefined) {
      await (this.#flushing ?? this.#draining);
    }
    await this.#snapshotting?.catch(() => undefined);
    await this.#checkpointer.close();
    if (this.#writer !== undefined && this.#writer.lost === undefined) {
      await this.#writer.rollback().catch(() => undefined);
    }
    if (this.#writer?.lost !== undefined) await this.#writer.stop();
    if (first !== undefined) {
      const unsafe = this.#taken
        .filter(({ commits }) => commits >= first.commit)
        .map(({ file }) => file);
      try {
        await discardSnapshots(this.#profile, unsafe);
      } catch (error) {
        console.error('Could not remove snapshots of what the core’s database lost:', error);
      }
      // Removing snapshots yields too: a loss heard meanwhile must finish before the WAL cut.
      if (this.#writer?.lost !== undefined) await this.#writer.stop();
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
    }
    if (this.#writer !== undefined) {
      // The writer closes while this connection, which only reads, holds the database: it never
      // checkpoints the log it was cut back to, and neither does this one as it closes.
      try {
        await this.#writer.close();
      } finally {
        this.#connection.close();
      }
      if (this.#log !== undefined) closeSync(this.#log);
      return;
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
    this.#checkpointNow(true).catch((error: unknown) => {
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

/**
 * Runs a write's statement; returns what hands its rows to its callback, if it has one, to run
 * once the rest of the write's statements have.
 */
function execute(statement: Statement, { params, expect, then }: Step): (() => void) | undefined {
  if (then !== undefined) {
    const rows = statement.all(...params);
    return () => {
      then(rows);
    };
  }
  const { changes } = statement.run(...params);
  if (expect !== undefined && Number(changes) !== expect.changes) throw new Error(expect.error);
  return undefined;
}

/** Gives the rows each of a write's `runReturning`s asked for to its callback, in order. */
function deliver(context: WriteContext, rows: readonly Row[][]): void {
  let next = 0;
  for (const step of context.steps) {
    if (step.then === undefined) continue;
    step.then(rows[next++] ?? []);
  }
}

/** `value`, which must not be a promise: what it awaits would run after the commit. */
function synchronously<T>(value: T): T {
  if (value instanceof Promise) {
    throw new Error(
      'A transaction’s function must be synchronous: it would commit before it finished.',
    );
  }
  return value;
}

/** What an outcome says of the transaction it began, if it did. */
function opened(frames: number | undefined): { frames?: number } {
  return frames === undefined ? {} : { frames };
}

/** The frames the log held, as SQLite said; fails if it didn't say. */
function framesOf(log: unknown): number {
  if (typeof log !== 'number' || !Number.isInteger(log) || log < 0) {
    throw new Error('SQLite did not say how long the core’s database’s log is.');
  }
  return log;
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
export type Database = Pick<
  Store,
  | 'prepare'
  | 'write'
  | 'writeBlocking'
  | 'run'
  | 'runExpecting'
  | 'runReturning'
  | 'undo'
  | 'followUp'
>;

/**
 * The database of a core whose store couldn't be opened: every read and write fails, saying `why`,
 * so the core journals nothing, and sends nothing whose record must be on disk first.
 */
export function unopened(why: string): Database {
  const refuse = (): never => {
    throw new Error(why);
  };
  return {
    prepare: refuse,
    write: () => Promise.reject(new Error(why)),
    writeBlocking: () => Promise.reject(new Error(why)),
    run: refuse,
    runExpecting: refuse,
    runReturning: refuse,
    undo: refuse,
    followUp: refuse,
  };
}
