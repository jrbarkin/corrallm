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
  {
    // B9's: a canvas's document as rows (B9 Design §2), what changed it, the proposals waiting on
    // you and the reviews of a file changed on disk. A corrallm of schema 1 would ignore the rows
    // and run a canvas as its file was, so it may no longer open the database. Until B9 merges,
    // this one may still be reshaped.
    version: 2,
    minReader: 2,
    sql: `
      -- A canvas's document: the last revision given (an op takes the next), whether structural
      -- edits lay it out, the SHA-256 of its text as last saved or read (saved_hash: whether it is
      -- edited), of its file's bytes as last read or written (file_hash: whether the file changed
      -- on disk), and of the text a save is writing until it is written (writing_hash); the party
      -- that created it, and the party and time of its last change. Its rows go with it.
      CREATE TABLE document (
        canvas_id TEXT PRIMARY KEY NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        rev INTEGER NOT NULL CHECK (rev >= 0),
        arrange INTEGER NOT NULL CHECK (arrange IN (0, 1)),
        saved_hash TEXT,
        file_hash TEXT,
        writing_hash TEXT,
        created_by TEXT,
        by_party TEXT NOT NULL,
        changed_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;

      -- Its agents and frames, in the document's order (place: a move rewrites one row), each
      -- inside its parent, if it has one. Only an agent runs (adapter, connection), is set to run
      -- with something (settings, by adapter) and has a role. The party that created it (created_by,
      -- none from a file), and each row's revision and its last writer.
      CREATE TABLE node (
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'frame')),
        parent_id TEXT CHECK (parent_id <> id),
        place REAL NOT NULL,
        label TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        color INTEGER,
        adapter TEXT,
        connection TEXT,
        settings TEXT CHECK (json_valid(settings)),
        role TEXT,
        created_by TEXT,
        rev INTEGER NOT NULL,
        by_party TEXT NOT NULL,
        PRIMARY KEY (canvas_id, id),
        FOREIGN KEY (canvas_id, parent_id) REFERENCES node (canvas_id, id),
        CHECK (kind = 'agent'
          OR (adapter IS NULL AND connection IS NULL AND settings IS NULL AND role IS NULL))
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX node_by_parent ON node (canvas_id, parent_id);

      -- Two agents that can talk, once, by their ids, the lesser first (a < b); drawn from
      -- source (one of them), between dots ([from, to]), in the document's order.
      CREATE TABLE link (
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        source TEXT NOT NULL,
        dots TEXT CHECK (json_valid(dots)),
        place REAL NOT NULL,
        rev INTEGER NOT NULL,
        by_party TEXT NOT NULL,
        PRIMARY KEY (canvas_id, a, b),
        FOREIGN KEY (canvas_id, a) REFERENCES node (canvas_id, id),
        FOREIGN KEY (canvas_id, b) REFERENCES node (canvas_id, id),
        CHECK (a < b),
        CHECK (source IN (a, b))
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX link_by_b ON link (canvas_id, b);

      -- An agent's queue items, ids unique across the whole queue: each in its queue's order, or
      -- in the order of the if-then or repeat holding it (container). Its fields but its id and
      -- what it holds are its body (never a live submission's record).
      CREATE TABLE queue_item (
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        id TEXT NOT NULL,
        container TEXT CHECK (container <> id),
        place REAL NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('step', 'message', 'if', 'wait', 'delay', 'approval', 'repeat')),
        body TEXT NOT NULL CHECK (json_valid(body)),
        rev INTEGER NOT NULL,
        by_party TEXT NOT NULL,
        PRIMARY KEY (canvas_id, agent_id, id),
        FOREIGN KEY (canvas_id, agent_id) REFERENCES node (canvas_id, id),
        FOREIGN KEY (canvas_id, agent_id, container) REFERENCES queue_item (canvas_id, agent_id, id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX queue_item_by_container ON queue_item (canvas_id, agent_id, container);

      -- Each revision of a document: the op that made it, the party that called it (and the one
      -- that proposed it, when you allowed a proposal), the request it carried, and when.
      CREATE TABLE revision (
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        rev INTEGER NOT NULL,
        op TEXT NOT NULL,
        by_party TEXT NOT NULL,
        proposed_by TEXT,
        request TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (canvas_id, rev)
      ) STRICT, WITHOUT ROWID;

      -- What a revision changed, entity by entity (node/<id>, link/<a>/<b>, item/<agent>/<id>,
      -- meta): its rows before and after (none: added, or removed), and its revision before.
      CREATE TABLE change (
        canvas_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        entity TEXT NOT NULL,
        rev_before INTEGER,
        before_data TEXT CHECK (json_valid(before_data)),
        after_data TEXT CHECK (json_valid(after_data)),
        PRIMARY KEY (canvas_id, rev, entity),
        FOREIGN KEY (canvas_id, rev) REFERENCES revision (canvas_id, rev) ON DELETE CASCADE
      ) STRICT;

      -- A token's op that waits for you to allow it (B9 Design §5): its arguments, the entities it
      -- touched and their revisions, what it would lose, and how it was settled, by whom and when.
      CREATE TABLE proposal (
        id TEXT PRIMARY KEY NOT NULL,
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        op TEXT NOT NULL,
        args TEXT NOT NULL CHECK (json_valid(args)),
        by_party TEXT NOT NULL,
        touched TEXT NOT NULL CHECK (json_valid(touched)),
        lost TEXT CHECK (json_valid(lost)),
        raised_at INTEGER NOT NULL,
        outcome TEXT,
        settled_by TEXT,
        settled_at INTEGER
      ) STRICT;
      CREATE INDEX proposal_by_canvas ON proposal (canvas_id);

      -- A canvas's file changed on disk, waiting for you to apply it or keep corrallm's: the
      -- file's hash and what changed, worded; one open (outcome none) at a time.
      CREATE TABLE file_review (
        id TEXT PRIMARY KEY NOT NULL,
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        file_hash TEXT NOT NULL,
        summary TEXT NOT NULL CHECK (json_valid(summary)),
        raised_at INTEGER NOT NULL,
        outcome TEXT,
        settled_by TEXT,
        settled_at INTEGER
      ) STRICT;
      CREATE INDEX file_review_by_canvas ON file_review (canvas_id);
      CREATE UNIQUE INDEX file_review_open ON file_review (canvas_id) WHERE outcome IS NULL;
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
