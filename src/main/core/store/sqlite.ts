import type * as Sqlite from 'node:sqlite';

/*
 * Node's SQLite (`node:sqlite`, Core Database §3), reached here alone, and only once a database is
 * opened: through `process.getBuiltinModule`, never a static import, which the bundler would hoist
 * above the CLI's check of Node's version. Node 26 renames its classes (DEP0210, DEP0211): this is
 * the one place to follow it.
 */

/** A connection to a database file. */
export type Connection = Sqlite.DatabaseSync;
/** A prepared statement of a connection. */
export type Statement = Sqlite.StatementSync;
export type ConnectOptions = Sqlite.DatabaseSyncOptions;

/** SQLite's primary result codes the store tells apart (sqlite.org/rescode.html). */
export const SQLITE_BUSY = 5;
export const SQLITE_CORRUPT = 11;
export const SQLITE_FULL = 13;
export const SQLITE_NOTADB = 26;
/** An extended one: a connection that only reads found a journal it must roll back first. */
export const SQLITE_READONLY_ROLLBACK = 776;

let loaded: typeof Sqlite | undefined;

function sqlite(): typeof Sqlite {
  loaded ??= process.getBuiltinModule('node:sqlite');
  return loaded;
}

/** Opens a connection to `file` (or ':memory:'). */
export function connect(file: string, options: ConnectOptions = {}): Connection {
  return new (sqlite().DatabaseSync)(file, options);
}

/**
 * Copies `source`'s database into `file`, `rate` pages a step (each step on Node's thread pool).
 * Resolves with how many pages it copied.
 */
export function backup(source: Connection, file: string, rate: number): Promise<number> {
  return sqlite().backup(source, file, { rate });
}

/**
 * The primary result code of an error SQLite gave (its extended code's low byte: a primary key's
 * 1555 is a constraint's 19), or undefined for an error of something else.
 */
export function resultCode(error: unknown): number | undefined {
  const code = extendedCode(error);
  return code === undefined ? undefined : code & 0xff;
}

/** The extended result code of an error SQLite gave, or undefined for one of something else. */
export function extendedCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('errcode' in error)) return undefined;
  return typeof error.errcode === 'number' ? error.errcode : undefined;
}
