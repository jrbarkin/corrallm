import type { Connection } from './sqlite';
import { transaction } from './transaction';

/*
 * The core database's schema (Core Database §5), made by migrations run in order, forward only:
 * each in one transaction with its version (SQLite's DDL is transactional), so a migration that
 * fails leaves the database as it was before it. PRAGMA user_version is the schema a database has;
 * meta.min_reader the oldest schema whose code may still open it. A migration that only adds
 * (tables, columns with defaults) keeps min_reader, so an older corrallm still opens the database
 * and writes only its own columns (never INSERT OR REPLACE, which would drop a newer one's); one
 * that changes what is there raises it. Once shipped, a migration is never edited: a change is a
 * migration of its own, with a test that seeds the schema before it.
 *
 * Tables are singular snake_case and STRICT, with NOT NULL wherever a value is required, and
 * column names no keyword of SQL's. Ids are TEXT, times epoch ms; JSON is TEXT that json_valid
 * checks. Everything of a canvas goes with it (ON DELETE CASCADE).
 */

export interface Migration {
  /** The schema it makes: user_version once it ran. */
  version: number;
  /** The oldest schema whose code may still open the database once it ran (meta.min_reader). */
  minReader: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    // B9.0's tables. Part B, which puts today's stores behind them, may still reshape them before
    // B9.0 merges; from then on, never.
    version: 1,
    minReader: 1,
    sql: `
      -- One row: the oldest schema whose code may still open the database.
      CREATE TABLE meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        min_reader INTEGER NOT NULL
      ) STRICT;

      -- What the profile keeps of each canvas: its file (none for a draft; a file belongs to one
      -- canvas at most) and its project folder, both paths the app's dialogs gave. The canvases
      -- used least recently are forgotten first (used_at).
      CREATE TABLE canvas (
        id TEXT PRIMARY KEY NOT NULL,
        file TEXT UNIQUE,
        project TEXT,
        used_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX canvas_by_use ON canvas (used_at);

      -- Each agent's native conversation in each adapter's CLI, and the role's fingerprint it
      -- launched with (none when not known).
      CREATE TABLE conversation (
        canvas_id TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        adapter TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        role_fingerprint TEXT,
        PRIMARY KEY (canvas_id, adapter, agent_id)
      ) STRICT, WITHOUT ROWID;

      -- A canvas's run: its state.
      CREATE TABLE run (
        canvas_id TEXT PRIMARY KEY NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (json_valid(state)),
        updated_at INTEGER NOT NULL
      ) STRICT;

      -- The workflow a canvas's run runs, and its SHA-256: a row of its own, written only when the
      -- hash changes, since SQLite writes a row whole, and a run's state changes far more often.
      CREATE TABLE run_workflow (
        canvas_id TEXT PRIMARY KEY NOT NULL REFERENCES run (canvas_id) ON DELETE CASCADE,
        workflow TEXT NOT NULL,
        hash TEXT NOT NULL
      ) STRICT;

      -- A canvas's messages, in the order they came: seq is never given again, even once the
      -- newest are deleted or a snapshot restored, so a cursor into it survives pruning,
      -- restarts and restores.
      CREATE TABLE message (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        canvas_id TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        from_party TEXT NOT NULL,
        to_party TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        reply_to TEXT,
        task TEXT CHECK (json_valid(task)),
        turn TEXT CHECK (json_valid(turn)),
        state TEXT NOT NULL,
        delivery TEXT CHECK (json_valid(delivery)),
        by_party TEXT,
        sent_at INTEGER NOT NULL,
        told TEXT,
        withdrawal TEXT CHECK (json_valid(withdrawal))
      ) STRICT;
      CREATE INDEX message_by_canvas ON message (canvas_id, seq);

      -- Where each party's wait has read to in a canvas's messages.
      CREATE TABLE read_position (
        canvas_id TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        party TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (canvas_id, party)
      ) STRICT, WITHOUT ROWID;

      -- The canvases the app opens again as it starts.
      CREATE TABLE open_canvas (
        canvas_id TEXT PRIMARY KEY NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        opened_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];

/** The schema this code makes and reads. */
export const SCHEMA = MIGRATIONS.length;

/**
 * The tables whose rows are numbered with places never given again (AUTOINCREMENT), which cursors
 * hold: a database restored numbers them on from past every place given before (open.ts).
 */
export const SEQUENCES: readonly string[] = ['message'];

/**
 * Runs the migrations a database lacks, in order, each with its version in one transaction. Each
 * runs with foreign keys off (sqlite.org/lang_altertable.html §7: set outside its transaction,
 * since SQLite ignores the pragma within one), so that it may rebuild a table others refer to:
 * dropping the old table would otherwise delete everything that refers to it. What it leaves is
 * checked instead, before it commits.
 */
export function migrate(
  connection: Connection,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  for (const { version, minReader, sql } of migrations) {
    if (version <= schemaOf(connection)) continue;
    const enforced = connection.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1;
    connection.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(connection, () => {
        connection.exec(sql);
        const dangling = connection.prepare('PRAGMA foreign_key_check').get();
        if (dangling !== undefined) {
          throw new Error(
            `The migration to schema ${String(version)} would leave ${String(dangling.table)} referring to a ${String(dangling.parent)} that isn’t there.`,
          );
        }
        connection
          .prepare(
            `INSERT INTO meta (id, min_reader) VALUES (1, ?)
             ON CONFLICT (id) DO UPDATE SET min_reader = excluded.min_reader`,
          )
          .run(minReader);
        connection.exec(`PRAGMA user_version = ${String(version)}`);
      });
    } finally {
      if (enforced) connection.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/** The schema a database has: 0 before its first migration. */
export function schemaOf(connection: Connection): number {
  return connection.prepare('PRAGMA user_version').get()?.user_version as number;
}

/** The oldest schema whose code may open a migrated database, if it says. */
export function minReaderOf(connection: Connection): number | undefined {
  const row = connection.prepare('SELECT min_reader FROM meta WHERE id = 1').get();
  return row?.min_reader as number | undefined;
}
