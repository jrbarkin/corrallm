import { convertToSchema4 } from './conversion-4';
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
  /**
   * What its SQL can't do (B11 Design §16 item 2: migration 4's alone), run by `migrate` within
   * the migration's transaction, through its connection, after its SQL and before what it leaves
   * is checked and its version recorded: it fails, or commits, with the rest of the migration. Its
   * module is reached from here alone, and refuses to run anywhere else (conversion-4.ts).
   */
  convert?: (connection: Connection) => void;
}

/**
 * The workspace key of a conversation whose CLI ran in the canvas's picked project folder itself,
 * rather than in a workspace of its own (whose key is the workspace's id): every conversation
 * schema 2 kept ran there. Kept in the database, so never changed.
 */
export const PROJECT_WORKSPACE = 'project';

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
      -- The workflow a run ran goes: a canvas's document is kept in its rows, and a canvas with
      -- none is read from its file (no profile ran schema 1 with work to keep: B9 Design §2).
      DROP TABLE run_workflow;

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
        file_generation INTEGER NOT NULL DEFAULT 0 CHECK (file_generation >= 0),
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
      -- file's hash, its confirmed-write generation and what changed, worded; one open (outcome
      -- none) at a time. Keep expires with the generation, even when a write repeats the same bytes.
      CREATE TABLE file_review (
        id TEXT PRIMARY KEY NOT NULL,
        canvas_id TEXT NOT NULL REFERENCES document (canvas_id) ON DELETE CASCADE,
        file_hash TEXT NOT NULL,
        file_generation INTEGER NOT NULL CHECK (file_generation >= 0),
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
  {
    // Workspaces: a canvas's agents work in checkouts of their own of the repository picked as its
    // project folder (Git worktrees, a group's agents sharing one), each conversation kept by the
    // checkout its CLI ran in. A corrallm of schema 2 would start every agent in the project folder
    // itself, resuming there conversations of another checkout, so it may no longer open the
    // database. Nothing here touches a repository: workspaces are made once it is open.
    version: 3,
    minReader: 3,
    sql: `
      -- Binding/plan generations survive clearing plans and deleting bindings, even with a clock
      -- set back. Allocated in the same write as their binding, never from in-memory counters.
      ALTER TABLE meta ADD COLUMN workspace_generation INTEGER NOT NULL DEFAULT 0
        CHECK (workspace_generation >= 0);

      -- Conversations, kept by the workspace their CLI ran in too: each of an agent's checkouts
      -- has a history of its own. Every one kept so far ran in the picked project folder itself.
      -- Rebuilt first, so that the tables made after it take the pages the old one leaves.
      CREATE TABLE conversation_by_workspace (
        canvas_id TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        adapter TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL CHECK (workspace_key <> ''),
        native_id TEXT NOT NULL,
        role_fingerprint TEXT,
        PRIMARY KEY (canvas_id, adapter, agent_id, workspace_key)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO conversation_by_workspace
        (canvas_id, adapter, agent_id, workspace_key, native_id, role_fingerprint)
        SELECT canvas_id, adapter, agent_id, '${PROJECT_WORKSPACE}', native_id, role_fingerprint
        FROM conversation;
      DROP TABLE conversation;
      ALTER TABLE conversation_by_workspace RENAME TO conversation;

      -- A repository a project folder is, on this profile: the checkout picked (as picked, and its
      -- real path), its common Git directory and what identifies it, and the folder its workspaces'
      -- checkouts are made in: inside the picked checkout ('project') or the profile ('profile').
      -- Its generation moves on whenever what is known of it changes.
      CREATE TABLE repository (
        id TEXT PRIMARY KEY NOT NULL,
        picked_root TEXT NOT NULL,
        real_root TEXT NOT NULL,
        common_dir TEXT NOT NULL,
        identity TEXT NOT NULL,
        root_kind TEXT NOT NULL CHECK (root_kind IN ('project', 'profile')),
        owned_root TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        UNIQUE (real_root, identity)
      ) STRICT;

      -- The repository a canvas's project folder is (none: a folder that isn't one, which its
      -- agents share), and the canvas's project generation, which moves on with every change of it.
      CREATE TABLE canvas_repository (
        canvas_id TEXT PRIMARY KEY NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        repository_id TEXT REFERENCES repository (id) ON DELETE RESTRICT,
        generation INTEGER NOT NULL CHECK (generation >= 0)
      ) STRICT;
      CREATE INDEX canvas_repository_by_repository ON canvas_repository (repository_id);

      -- A canvas's workspace: its own checkout of the repository (path) on its own branch
      -- (branch_ref), made from the picked checkout's commit (base_oid, and the branch it was on,
      -- base_ref) or forked from another workspace's; the outermost group or lone agent it is for
      -- (owner_key), its state and generation. Each owner has at most one active (neither kept,
      -- 'retained', nor 'removing') at a time. A canvas that has one, in any state, is never
      -- forgotten: what it holds may be the only copy of an agent's work.
      CREATE TABLE worktree (
        id TEXT PRIMARY KEY NOT NULL,
        canvas_id TEXT NOT NULL REFERENCES canvas (id) ON DELETE RESTRICT,
        repository_id TEXT NOT NULL REFERENCES repository (id) ON DELETE RESTRICT,
        owner_key TEXT NOT NULL CHECK (owner_key GLOB 'agent/?*' OR owner_key GLOB 'group/?*'),
        path TEXT NOT NULL UNIQUE,
        branch_ref TEXT NOT NULL,
        base_checkout TEXT NOT NULL,
        base_ref TEXT,
        base_oid TEXT NOT NULL,
        forked_from TEXT REFERENCES worktree (id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN
          ('creating', 'setup', 'ready', 'missing', 'error', 'retained', 'removing')),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        created_at INTEGER NOT NULL,
        error_code TEXT,
        UNIQUE (canvas_id, id),
        UNIQUE (repository_id, branch_ref)
      ) STRICT;
      CREATE UNIQUE INDEX worktree_active ON worktree (canvas_id, repository_id, owner_key)
        WHERE state NOT IN ('retained', 'removing');
      CREATE INDEX worktree_by_fork ON worktree (forked_from);

      -- Each agent's workspace, of its own canvas, and the generation of that binding; while a
      -- change of it waits, the owner it is to move to and the generation it would have then. No
      -- reference to the agent's node: a binding outlives its node until what removing it leaves
      -- is settled, and its workspace is kept while a binding refers to it.
      CREATE TABLE agent_worktree (
        canvas_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        desired_generation INTEGER,
        desired_owner_key TEXT,
        PRIMARY KEY (canvas_id, agent_id),
        FOREIGN KEY (canvas_id, workspace_id) REFERENCES worktree (canvas_id, id)
          ON DELETE RESTRICT,
        CHECK ((desired_generation IS NULL) = (desired_owner_key IS NULL)),
        CHECK (desired_generation > generation),
        CHECK (desired_owner_key GLOB 'agent/?*' OR desired_owner_key GLOB 'group/?*')
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX agent_worktree_by_workspace ON agent_worktree (canvas_id, workspace_id);

      -- What is to be done to a workspace, recorded before any of it is, so that a restart
      -- finishes it rather than doing it again: its kind, the phase it reached, the generation it
      -- is for, the repository identity it expects, what it needs (payload) and how it ended (none
      -- while it goes on). At most one of each kind goes on for a workspace at a time.
      CREATE TABLE worktree_job (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES worktree (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        phase TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        expected_identity TEXT,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        intent_hash TEXT NOT NULL CHECK (length(intent_hash) = 64),
        outcome TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX worktree_job_by_workspace ON worktree_job (workspace_id, created_at);
      CREATE UNIQUE INDEX worktree_job_open ON worktree_job (workspace_id, kind)
        WHERE outcome IS NULL;

      -- A workspace's setup, a generation at a time: the command as it was offered (none if there
      -- is none), where it came from, the hashes of exactly what runs and how (spec_hash) and of
      -- the local files copied in (copy_manifest_hash), its state, who allowed it to run and
      -- when, and the key of its output's log and how it exited. Nothing runs unallowed.
      CREATE TABLE worktree_setup (
        workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES worktree (id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        command_snapshot TEXT,
        source TEXT NOT NULL CHECK (source IN ('configured', 'detected', 'none')),
        spec_hash TEXT NOT NULL,
        copy_manifest_hash TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('pending', 'running', 'done', 'skipped', 'failed', 'interrupted')),
        approved_by TEXT,
        approved_at INTEGER,
        log_key TEXT,
        exit_code INTEGER,
        CHECK ((source = 'none') = (command_snapshot IS NULL)),
        CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
        CHECK (state IN ('pending', 'skipped') OR approved_by IS NOT NULL)
      ) STRICT;

      -- How a repository's workspaces are set up on this profile: the command you set for it
      -- (none: the one detected, if any) and how it runs, the hash of exactly what you allowed to
      -- run always (none: each workspace asks), and when either last changed.
      CREATE TABLE project_setup (
        repository_id TEXT PRIMARY KEY NOT NULL REFERENCES repository (id) ON DELETE CASCADE,
        command TEXT,
        shell_kind TEXT,
        always_spec_hash TEXT,
        changed_at INTEGER NOT NULL,
        CHECK ((command IS NULL) = (shell_kind IS NULL))
      ) STRICT;
    `,
  },
  {
    // B11's (B11 Design §4): how each message came to be, and what a view shows of it, so that
    // your manual messages are the mailbox's, never a run checkpoint's; each run journaled in an
    // envelope of its own, with no submissions beside it. A corrallm of schema 3 would journal a
    // window's checkpoint over it, writing messages with no origin, and take a resend for a
    // reply, so it may no longer open the database.
    version: 4,
    minReader: 4,
    sql: `
      -- How each message came to be (origin): typed by you, a party's or corrallm's, the run's,
      -- or one you asked to send again, and the message it sends again (resend_of: never its
      -- reply_to, which is only a reply's, or a record's about another); what a view shows of it
      -- beside its body (display: never an image's bytes). Rebuilt, rather than given columns
      -- with defaults, so that every row written names its origin; its rows set aside first, so
      -- that the new table takes the pages the old one leaves. Each existing one by what made it:
      -- Interrupt and resend's (marked by its notice key and its reply link, which move to
      -- resend_of; one that needed images it no longer has requires them), yours, or a party's.
      -- Every place given stays given, the newest deleted ones' too (SEQUENCES).
      CREATE TEMP TABLE message_3 AS SELECT * FROM message;
      CREATE TEMP TABLE message_3_sequence AS
        SELECT seq FROM sqlite_sequence WHERE name = 'message';
      DROP TABLE message;
      CREATE TABLE message (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        canvas_id TEXT NOT NULL REFERENCES canvas (id) ON DELETE CASCADE,
        from_party TEXT NOT NULL,
        to_party TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('manual', 'party', 'run', 'resend')),
        body TEXT NOT NULL,
        display TEXT CHECK (json_valid(display)),
        reply_to TEXT,
        resend_of TEXT CHECK (resend_of IS NULL OR origin = 'resend'),
        task TEXT CHECK (json_valid(task)),
        turn TEXT CHECK (json_valid(turn)),
        state TEXT NOT NULL,
        delivery TEXT CHECK (json_valid(delivery)),
        by_party TEXT,
        sent_at INTEGER NOT NULL,
        told TEXT,
        withdrawal TEXT CHECK (json_valid(withdrawal))
      ) STRICT;
      INSERT INTO message (seq, id, canvas_id, from_party, to_party, kind, origin, body, display,
          reply_to, resend_of, task, turn, state, delivery, by_party, sent_at, told, withdrawal)
        SELECT seq, id, canvas_id, from_party, to_party, kind,
          CASE WHEN resend THEN 'resend' WHEN from_party = 'you' THEN 'manual' ELSE 'party' END,
          body,
          CASE WHEN resend AND told = 'resend:' || reply_to || ':images'
            THEN '{"requiresImages":true}' END,
          CASE WHEN resend THEN NULL ELSE reply_to END,
          CASE WHEN resend THEN reply_to END,
          task, turn, state, delivery, by_party, sent_at,
          CASE WHEN resend THEN NULL ELSE told END,
          withdrawal
        FROM (SELECT *, coalesce(reply_to IS NOT NULL
            AND told IN ('resend:' || reply_to, 'resend:' || reply_to || ':images'), 0) AS resend
          FROM temp.message_3);
      CREATE INDEX message_by_canvas ON message (canvas_id, seq);
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'message', 0
        WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'message');
      UPDATE sqlite_sequence
        SET seq = max(seq, coalesce((SELECT seq FROM temp.message_3_sequence), 0))
        WHERE name = 'message';
      DROP TABLE temp.message_3;
      DROP TABLE temp.message_3_sequence;
    `,
    // Each run's envelope, and its submissions your messages (conversion-4.ts).
    convert: convertToSchema4,
  },
  {
    // B11a's (B11a Design §12 C1, C2): an agent's fallback chain, with where the run is in it, and
    // its handoff settings, kept with its row as the document has them. A corrallm of schema 4
    // would read agents without their chain and change how they run with a stale place in it, so,
    // as a file of version 3 is to it, it may no longer open the database.
    version: 5,
    minReader: 5,
    sql: `
      -- The chain you set (fallback: its steps, whether it returns, and the step corrallm switched
      -- the agent to, with the endpoint it came from) and the handoff settings (handoff): JSON as
      -- the document's own, only an agent's.
      ALTER TABLE node ADD COLUMN fallback TEXT
        CHECK (fallback IS NULL OR (kind = 'agent' AND json_valid(fallback)));
      ALTER TABLE node ADD COLUMN handoff TEXT
        CHECK (handoff IS NULL OR (kind = 'agent' AND json_valid(handoff)));
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
  for (const { version, minReader, sql, convert } of migrations) {
    if (version <= schemaOf(connection)) continue;
    const enforced = connection.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1;
    connection.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(connection, () => {
        connection.exec(sql);
        convert?.(connection);
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
