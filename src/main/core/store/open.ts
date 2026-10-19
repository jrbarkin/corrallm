import { closeSync, openSync } from 'node:fs';
import path from 'node:path';

import { migrate, minReaderOf, SCHEMA, schemaOf } from './migrations';
import { connect } from './sqlite';
import type { Connection } from './sqlite';
import { Store, SYSTEM_DEPS } from './store';
import type { StoreDeps } from './store';

/*
 * Opening the profile's database (Core Database §5): <profile>/core.db, made 0600 before SQLite
 * opens it, so that its write-ahead log (-wal) and its index (-shm), which SQLite makes with the
 * database's mode, are the user's alone too. Then, in this order: on a new, empty database,
 * incremental vacuuming (which only a database with no tables can take) and corrallm's
 * application id; the write-ahead log; every commit forced to disk (synchronous FULL and, on
 * macOS, F_FULLFSYNC, as Node's own fsync is there: SQLite's plain fsync leaves it in the drive's
 * cache); foreign keys; no functions from the schema it didn't make (trusted_schema); the log
 * kept within JOURNAL_SIZE_LIMIT and checkpointed by the store when it is idle, never in the
 * middle of a commit; then SQLite's quick check, and the migrations it lacks.
 *
 * Opening never throws (the host gives up on a core that crashes three times in a minute): it
 * resolves with the store, or none, and what it found to say. A database a newer corrallm made
 * that this one can't read (meta.min_reader above SCHEMA) is left as it is.
 */

export const STORE_FILE = 'core.db';
/** Marks core.db as corrallm's: "CRLM". */
export const APPLICATION_ID = 0x43524c4d;
/**
 * How large the log may stay once checkpointed (its file is reused, not regrown): 4 MiB, about
 * what a thousand pages fill, so a burst of writes between checkpoints doesn't regrow it.
 */
export const JOURNAL_SIZE_LIMIT = 4 * 2 ** 20;
/**
 * How long a statement waits for another connection to let go of the database: not at all. The
 * core is its only writer (core.lock) through one connection, so the database is never busy but
 * for a bug, which a wait would only hide, blocking the core's loop meanwhile (SQLite's wait is
 * synchronous); a reader of the log never blocks a writer.
 */
const BUSY_TIMEOUT_MS = 0;

/** What opening the store found: the store, or none, and what to say. */
export interface Opened {
  /** None if it couldn't be opened: `said` says why. */
  store: Store | undefined;
  /** Sentences: what it set aside, restored or refused. */
  said: string[];
}

/** Opens the profile's database, as the core opens it once it holds core.lock. Never rejects. */
export function openStore(profile: string, deps: StoreDeps = SYSTEM_DEPS): Promise<Opened> {
  const file = path.join(profile, STORE_FILE);
  try {
    return Promise.resolve({ store: new Store(openConnection(file), file, deps), said: [] });
  } catch (error) {
    if (error instanceof Refusal)
      return Promise.resolve({ store: undefined, said: [error.message] });
    return Promise.resolve({
      store: undefined,
      said: [`The core’s database could not be opened (${reason(error)}).`],
    });
  }
}

/** A database this code must not open: the sentence says why. */
class Refusal extends Error {}

function openConnection(file: string): Connection {
  create(file);
  const connection = connect(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    setUp(connection, file);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Makes the database's file, the user's alone, unless it is there. */
function create(file: string): void {
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
  }
}

function setUp(connection: Connection, file: string): void {
  const objects = connection.prepare('SELECT count(*) AS objects FROM sqlite_schema').get();
  if (objects?.objects === 0) {
    connection.exec('PRAGMA auto_vacuum = INCREMENTAL');
    // A database SQLite had begun takes it only once vacuumed (an empty one at once).
    if (connection.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum !== 2)
      connection.exec('VACUUM');
    connection.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
  } else if (schemaOf(connection) > 0 && (minReaderOf(connection) ?? 0) > SCHEMA) {
    throw new Refusal(
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    );
  }
  const mode = connection.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
  if (mode !== 'wal') {
    throw new Error(`SQLite would not keep a write-ahead log: its journal mode is ${String(mode)}`);
  }
  connection.exec('PRAGMA synchronous = FULL');
  if (process.platform === 'darwin') {
    connection.exec('PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON');
  }
  connection.exec(`PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;
    PRAGMA journal_size_limit = ${String(JOURNAL_SIZE_LIMIT)}; PRAGMA wal_autocheckpoint = 0`);
  migrate(connection);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
