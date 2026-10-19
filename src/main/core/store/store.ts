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
 */

/** A write waiting in the lane. */
interface Queued {
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class Store {
  /** The database's file. */
  readonly file: string;
  readonly #connection: Connection;
  /** Each statement prepared, by its SQL. */
  readonly #statements = new Map<string, Statement>();
  /** The writes waiting for the lane's next commit, in order. */
  #queue: Queued[] = [];
  #scheduled = false;
  #closing: Promise<void> | undefined;

  constructor(connection: Connection, file: string) {
    this.#connection = connection;
    this.file = file;
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
   */
  tx<T>(run: () => T): T {
    return transaction(this.#connection, run);
  }

  /**
   * Queues `run` (synchronous, with no await inside) for the lane's next commit, with the other
   * writes queued in this turn of the loop. Resolves with what it returned once that commit has
   * returned; rejects, keeping nothing of it, if it threw or the commit failed.
   */
  write<T>(run: () => T): Promise<T> {
    if (this.#closing !== undefined) {
      return Promise.reject(new Error('The core’s database is closed.'));
    }
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
   * Closes the database once the writes queued so far are committed, checkpointing its log into it.
   * Writes asked for meanwhile are refused. Closing it again does nothing more.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    await Promise.resolve();
    this.#flush();
    try {
      this.#connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch (error) {
      console.error('Could not checkpoint the core’s database as it closed:', error);
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
    return [];
  }
}
