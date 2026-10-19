import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { faults } from './faults';
import { migrate, minReaderOf, SCHEMA, schemaOf, SEQUENCES } from './migrations';
import { settleRestored } from './restored';
import { restoreSnapshot, snapshots, snapshotTime } from './snapshots';
import {
  connect,
  extendedCode,
  resultCode,
  SQLITE_CORRUPT,
  SQLITE_NOTADB,
  SQLITE_READONLY_ROLLBACK,
} from './sqlite';
import type { Connection } from './sqlite';
import { Store, SYSTEM_DEPS } from './store';
import type { StoreDeps } from './store';
import { transaction } from './transaction';

/*
 * Opening the profile's database (Core Database §5): <profile>/core.db, made 0600 before SQLite
 * opens it, so that its write-ahead log (-wal) and its index (-shm), which SQLite makes with the
 * database's mode, are the user's alone too. A database that was there is checked first, read
 * only (`vet`): that it is corrallm's, that this code may read it, and SQLite's quick check. Then,
 * in this order: on a new, empty database, incremental vacuuming (which only a database with no
 * tables can take) and corrallm's application id; the write-ahead log; every commit forced to
 * disk (synchronous FULL and, on macOS, F_FULLFSYNC, as Node's own fsync is there: SQLite's plain
 * fsync leaves it in the drive's cache); foreign keys; no functions from a schema it didn't make
 * (trusted_schema); the log kept within JOURNAL_SIZE_LIMIT and checkpointed by the store when it
 * is idle, never in the middle of a commit; then the migrations it lacks.
 *
 * Opening never throws (the host gives up on a core that crashes three times in a minute): it
 * resolves with the store, or none, and what it found to say. A database a newer corrallm made
 * that this one can't read (meta.min_reader above SCHEMA) is left as it is. A damaged one (SQLite
 * says it is corrupt or no database, its quick check finds a fault, or it isn't corrallm's) is
 * set aside as core.rejected-<uuid>.db with its log, index and journal, the log first: a log left
 * without its database could otherwise be replayed into the next one. Then the newest snapshot that
 * passes the same checks is restored, else the store starts empty, and it says so; a restore cut
 * short (core.db gone, its snapshots there) is finished as the store next opens. Whatever
 * restoring loses, the core treats as a restart does: what was being sent is never sent again, nor
 * is what waited to be sent (restored.ts).
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
/**
 * The files SQLite keeps beside the database: its log, the log's index, and the journal it keeps
 * before it keeps a log (as it is set up).
 */
const SIDECARS = ['-wal', '-shm', '-journal'];

/** What opening the store found: the store, or none, and what to say. */
export interface Opened {
  /** None if it couldn't be opened: `said` says why. */
  store: Store | undefined;
  /** Sentences: what it set aside, restored or refused. */
  said: string[];
}

/** Opens the profile's database, as the core opens it once it holds core.lock. Never rejects. */
export async function openStore(profile: string, deps: StoreDeps = SYSTEM_DEPS): Promise<Opened> {
  const file = path.join(profile, STORE_FILE);
  const said: string[] = [];
  try {
    let connection: Connection;
    if (!existsSync(file) && (await snapshots(profile)).length > 0) {
      // Set aside without a snapshot in its place yet: a restore cut short, finished now.
      said.push(`The core’s database (${file}) was missing.`);
      connection = await restore(profile, file, deps.now(), said);
    } else {
      try {
        connection = openConnection(file);
      } catch (error) {
        if (!isDamage(error)) throw error;
        connection = await recover(profile, file, reason(error), deps.now(), said);
      }
    }
    const [newest] = await snapshots(profile).catch(() => []);
    const snapshotAt = newest === undefined ? undefined : snapshotTime(path.basename(newest));
    return { store: new Store(connection, { profile, file, deps, snapshotAt }), said };
  } catch (error) {
    const why =
      error instanceof Refusal
        ? error.message
        : `The core’s database could not be opened (${reason(error)}).`;
    return { store: undefined, said: [...said, why] };
  }
}

/** A database this code must not open: the sentence says why. */
class Refusal extends Error {}
/** A database damaged in a way SQLite doesn't throw for: the message says how. */
class Damage extends Error {}

function isDamage(error: unknown): boolean {
  if (error instanceof Damage) return true;
  const code = resultCode(error);
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB;
}

/**
 * Sets the damaged database aside and opens the newest sound snapshot in its place, or an empty
 * database, saying which in `said`.
 */
async function recover(
  profile: string,
  file: string,
  why: string,
  now: number,
  said: string[],
): Promise<Connection> {
  const rejected = path.join(profile, `core.rejected-${randomUUID()}.db`);
  // The log first: a log left without its database is never replayed into another.
  for (const suffix of [...SIDECARS, '']) {
    await moveIfThere(`${file}${suffix}`, `${rejected}${suffix}`);
  }
  said.push(`The core’s database was damaged (${why}), and was moved to ${rejected}.`);
  return restore(profile, file, now, said);
}

/**
 * Opens the newest sound snapshot in the place of a database that is gone, or an empty database,
 * saying which in `said`, numbering rows on from past every place the one gone gave (`numberOn`).
 */
async function restore(
  profile: string,
  file: string,
  now: number,
  said: string[],
): Promise<Connection> {
  // A log or journal left without its database belongs to none (SQLite deletes one it finds
  // beside an empty file): replayed into the snapshot, it would damage it.
  for (const suffix of SIDECARS) await rm(`${file}${suffix}`, { force: true });
  for (const snapshot of await snapshots(profile)) {
    if (!sound(snapshot)) continue;
    await restoreSnapshot(snapshot, file);
    const at = new Date(snapshotTime(path.basename(snapshot)) ?? 0).toISOString();
    said.push(`It was restored from its snapshot of ${at}: what changed since then is lost.`);
    return numberOn(openConnection(file), now);
  }
  said.push('It starts empty.');
  return numberOn(openConnection(file), now);
}

/**
 * Numbers rows on, in each table whose places are never given again (SEQUENCES), from past every
 * place the database a restore replaced may have given, which a cursor may hold: from the clock,
 * in milliseconds, unless the snapshot's places are past it already. A profile gives far fewer
 * than one place a millisecond, even since a restore last did this: only a clock set back since
 * then could give a place again. Then, in the same transaction, it settles what waited in the
 * snapshot (restored.ts).
 */
function numberOn(connection: Connection, now: number): Connection {
  try {
    transaction(connection, () => {
      for (const table of SEQUENCES) {
        const raised = connection
          .prepare('UPDATE sqlite_sequence SET seq = max(seq, CAST(? AS INTEGER)) WHERE name = ?')
          .run(now, table);
        if (raised.changes > 0) continue;
        connection
          .prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))')
          .run(table, now);
      }
      settleRestored(connection, now);
    });
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/**
 * Whether a snapshot is one to restore: a database corrallm set up, that this code may read, and
 * that passes SQLite's quick check, as a database that was there must (not, say, an empty file).
 */
function sound(snapshot: string): boolean {
  try {
    const copy = connect(snapshot, { readOnly: true });
    try {
      return schemaOf(copy) > 0 && unfit(copy, snapshot) === undefined;
    } finally {
      copy.close();
    }
  } catch {
    return false;
  }
}

function openConnection(file: string): Connection {
  if (!create(file)) vet(file);
  const connection = connect(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    setUp(connection);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Makes the database's file, the user's alone, unless it is there: whether it made it. */
function create(file: string): boolean {
  try {
    closeSync(openSync(file, 'wx', 0o600));
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  }
}

/**
 * Checks a database that was there before it is written: that it is corrallm's, that this code
 * can read it, and that SQLite's quick check finds nothing wrong. Through a connection that only
 * reads, so that one it refuses or sets aside is left as it was, its log with it: a connection
 * that writes would checkpoint the log into it, and delete it, as it closed. The log and index
 * SQLite makes for it meanwhile go again if it fails.
 *
 * But a transaction a crash left in its journal (as while it is set up, before it keeps a log),
 * which a connection that only reads can't roll back, is rolled back first, as any connection
 * that writes to it would: a database with a journal to roll back keeps no log to checkpoint.
 */
function vet(file: string): void {
  try {
    check(file);
  } catch (error) {
    if (extendedCode(error) !== SQLITE_READONLY_ROLLBACK) throw error;
    const writer = connect(file, { timeout: BUSY_TIMEOUT_MS });
    try {
      writer.prepare('SELECT count(*) FROM sqlite_schema').get();
    } finally {
      writer.close();
    }
    check(file);
  }
}

function check(file: string): void {
  const made = SIDECARS.filter((suffix) => !existsSync(`${file}${suffix}`));
  const reader = connect(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const objects = reader.prepare('SELECT count(*) AS objects FROM sqlite_schema').get();
    // An empty database SQLite had begun: set up as a new one.
    if (objects?.objects === 0) return;
    const wrong = unfit(reader, file);
    if (wrong !== undefined) throw wrong;
  } catch (error) {
    reader.close();
    for (const suffix of made) rmSync(`${file}${suffix}`, { force: true });
    throw error;
  }
  reader.close();
}

/**
 * Why this code must not open a database that has begun, read through a connection that only
 * reads: it isn't corrallm's, a newer corrallm made it that this one can't read, or SQLite's quick
 * check finds a fault. Nothing if it may.
 */
function unfit(reader: Connection, file: string): Damage | Refusal | undefined {
  if (reader.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) {
    return new Damage('it isn’t corrallm’s');
  }
  if (schemaOf(reader) > 0 && (minReaderOf(reader) ?? 0) > SCHEMA) {
    return new Refusal(
      `The core’s database (${file}) was made by a newer corrallm, which this one can’t read, and was left as it is: open this profile with that corrallm, or a newer one.`,
    );
  }
  const found = faults(reader);
  return found === undefined ? undefined : new Damage(`SQLite’s check found: ${found}`);
}

/** Sets up a connection to a database `vet` passed, or a new one, as the core needs it. */
function setUp(connection: Connection): void {
  const objects = connection.prepare('SELECT count(*) AS objects FROM sqlite_schema').get();
  if (objects?.objects === 0) {
    connection.exec('PRAGMA auto_vacuum = INCREMENTAL');
    // A database SQLite had begun takes it only once vacuumed (an empty one at once).
    const vacuum = connection.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
    if (vacuum !== 2) connection.exec('VACUUM');
    connection.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
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

async function moveIfThere(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
