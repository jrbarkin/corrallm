import type { Connection, Statement } from './sqlite';
import { transaction } from './transaction';

/*
 * The core's database (Core Database §5), open: one connection to <profile>/core.db, which only
 * the core writes (it holds core.lock). openStore (open.ts) opens it.
 */

export class Store {
  /** The database's file. */
  readonly file: string;
  readonly #connection: Connection;
  /** Each statement prepared, by its SQL. */
  readonly #statements = new Map<string, Statement>();
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

  /** Closes the database, checkpointing its log into it. Closing it again does nothing more. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    await Promise.resolve();
    try {
      this.#connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch (error) {
      console.error('Could not checkpoint the core’s database as it closed:', error);
    }
    this.#connection.close();
  }
}
