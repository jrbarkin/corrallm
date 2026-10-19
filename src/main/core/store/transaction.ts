import type { Connection } from './sqlite';

/*
 * A transaction on a connection (Core Database §3): BEGIN IMMEDIATE, which takes the database for
 * writing at once rather than at the first write, then `run`, then COMMIT. `run` is synchronous,
 * with no await inside: what it did is committed as soon as it returns. Within a transaction, one
 * nests as a SAVEPOINT. On an error, what `run` did is rolled back, and the error thrown as it
 * was: rolled back only if SQLite hasn't already, as it has on a full disk (SQLITE_FULL), where a
 * ROLLBACK of its own would throw instead and hide why.
 */

export function transaction<T>(connection: Connection, run: () => T): T {
  if (connection.isTransaction) return savepoint(connection, run);
  connection.exec('BEGIN IMMEDIATE');
  try {
    const value = synchronously(run);
    connection.exec('COMMIT');
    return value;
  } catch (error) {
    rollback(connection);
    throw error;
  }
}

/**
 * `run` within the transaction going on, as a SAVEPOINT: on an error, what it did is rolled back,
 * and the transaction goes on. Savepoints nest by name, the innermost first.
 */
export function savepoint<T>(connection: Connection, run: () => T): T {
  connection.exec('SAVEPOINT nested');
  try {
    const value = synchronously(run);
    connection.exec('RELEASE nested');
    return value;
  } catch (error) {
    undo(connection, 'ROLLBACK TO nested; RELEASE nested');
    throw error;
  }
}

function synchronously<T>(run: () => T): T {
  const value = run();
  if (value instanceof Promise) {
    // What it awaits would run after the commit, outside the transaction.
    throw new Error(
      'A transaction’s function must be synchronous: it would commit before it finished.',
    );
  }
  return value;
}

/**
 * Rolls back the transaction going on, if SQLite hasn't already. Never throws: the error that made
 * it is the one to throw.
 */
export function rollback(connection: Connection): void {
  undo(connection, 'ROLLBACK');
}

function undo(connection: Connection, sql: string): void {
  if (!connection.isTransaction) return;
  try {
    connection.exec(sql);
  } catch {
    // The error that made the rollback is the one to throw.
  }
}
