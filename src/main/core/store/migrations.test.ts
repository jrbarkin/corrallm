import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  migrate,
  MIGRATIONS,
  minReaderOf,
  PROJECT_WORKSPACE,
  SCHEMA,
  schemaOf,
  SEQUENCES,
} from './migrations';
import type { Migration } from './migrations';
import { connect } from './sqlite';
import type { Connection } from './sqlite';

/*
 * The core database's schema (Core Database §5): forward-only migrations, each run with its version
 * in one transaction, tracked by PRAGMA user_version and the oldest schema whose code may still
 * open the database (meta.min_reader).
 */

let folder: string;
let file: string;
let connection: Connection;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-migrations-'));
  file = path.join(folder, 'core.db');
  connection = connect(file);
});

afterEach(async () => {
  if (connection.isOpen) connection.close();
  await rm(folder, { recursive: true, force: true });
});

const tables = () =>
  connection
    .prepare(
      "SELECT name, strict, wr FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite%' ORDER BY name",
    )
    .all();

const CANVAS = '0a6f6a5e-4bb3-4c3e-8a8c-3f7f2c1e9d10';

function addCanvas(id = CANVAS): void {
  connection.prepare('INSERT INTO canvas (id, used_at) VALUES (?, 1)').run(id);
}
/** Adds your message to an agent; from schema 4, with how it came to be (yours: manual). */
function addMessage(id: string, canvas = CANVAS, origin = 'manual'): number {
  const row =
    schemaOf(connection) < 4
      ? connection
          .prepare(
            `INSERT INTO message (id, canvas_id, from_party, to_party, kind, body, state, sent_at)
             VALUES (?, ?, 'you', 'agent:a', 'text', 'Hello', 'pending', 1) RETURNING seq`,
          )
          .get(id, canvas)
      : connection
          .prepare(
            `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, state,
               sent_at)
             VALUES (?, ?, 'you', 'agent:a', 'text', ?, 'Hello', 'pending', 1) RETURNING seq`,
          )
          .get(id, canvas, origin);
  return row?.seq as number;
}

/** Adds a document to the canvas, as its first commit would: revision 1, by you. */
function addDocument(canvas = CANVAS): void {
  connection
    .prepare(
      `INSERT INTO document (canvas_id, rev, arrange, by_party, changed_at)
       VALUES (?, 1, 0, 'you', 1)`,
    )
    .run(canvas);
}
function addNode(id: string, kind = 'agent', parent: string | null = null, canvas = CANVAS): void {
  connection
    .prepare(
      `INSERT INTO node (canvas_id, id, kind, parent_id, place, label, x, y, rev, by_party)
       VALUES (?, ?, ?, ?, 0, ?, 0, 0, 1, 'you')`,
    )
    .run(canvas, id, kind, parent, id);
}
function addItem(agent: string, id: string, container: string | null = null): void {
  connection
    .prepare(
      `INSERT INTO queue_item (canvas_id, agent_id, id, container, place, kind, body, rev, by_party)
       VALUES (?, ?, ?, ?, 0, 'message', '{"message":"Hello"}', 1, 'you')`,
    )
    .run(CANVAS, agent, id, container);
}
function addLink(a: string, b: string, source = a): void {
  connection
    .prepare(
      `INSERT INTO link (canvas_id, a, b, source, place, rev, by_party)
       VALUES (?, ?, ?, ?, 0, 1, 'you')`,
    )
    .run(CANVAS, a, b, source);
}

describe('the schema', () => {
  it('migrates an empty database to the latest schema: singular tables, each STRICT', () => {
    migrate(connection);
    expect(schemaOf(connection)).toBe(SCHEMA);
    expect(minReaderOf(connection)).toBe(MIGRATIONS.at(-1)?.minReader);
    expect(tables()).toEqual([
      { name: 'agent_worktree', strict: 1, wr: 1 },
      { name: 'canvas', strict: 1, wr: 0 },
      { name: 'canvas_repository', strict: 1, wr: 0 },
      { name: 'change', strict: 1, wr: 0 },
      { name: 'conversation', strict: 1, wr: 1 },
      { name: 'document', strict: 1, wr: 1 },
      { name: 'file_review', strict: 1, wr: 0 },
      { name: 'link', strict: 1, wr: 1 },
      { name: 'merge_job', strict: 1, wr: 0 },
      { name: 'message', strict: 1, wr: 0 },
      { name: 'meta', strict: 1, wr: 0 },
      { name: 'node', strict: 1, wr: 1 },
      { name: 'open_canvas', strict: 1, wr: 0 },
      { name: 'project_setup', strict: 1, wr: 0 },
      { name: 'proposal', strict: 1, wr: 0 },
      { name: 'queue_item', strict: 1, wr: 1 },
      { name: 'read_position', strict: 1, wr: 1 },
      { name: 'repository', strict: 1, wr: 0 },
      { name: 'revision', strict: 1, wr: 1 },
      { name: 'run', strict: 1, wr: 0 },
      { name: 'worktree', strict: 1, wr: 0 },
      { name: 'worktree_job', strict: 1, wr: 0 },
      { name: 'worktree_setup', strict: 1, wr: 0 },
    ]);
  });

  it('indexes the side of every foreign key that refers, so a parent’s change finds its children', () => {
    migrate(connection);
    const unindexed = tables().flatMap(({ name }) => {
      const table = String(name);
      const keys = new Map<number, string[]>();
      for (const { id, from } of connection
        .prepare('SELECT id, seq, "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq')
        .all(table)) {
        keys.set(Number(id), [...(keys.get(Number(id)) ?? []), String(from)]);
      }
      const indexes = connection
        .prepare('SELECT name FROM pragma_index_list(?) WHERE partial = 0')
        .all(table)
        .map(({ name: index }) =>
          connection
            .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
            .all(String(index))
            .map((column) => String(column.name)),
        );
      return [...keys.values()]
        .filter((columns) =>
          indexes.every((index) => columns.some((column, i) => index[i] !== column)),
        )
        .map((columns) => `${table} (${columns.join(', ')})`);
    });
    expect(unindexed).toEqual([]);
  });

  it('checks a document’s references as each statement ends, never deferring them to the commit', () => {
    migrate(connection);
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
    addDocument();
    addNode('lead');
    connection.exec('BEGIN');
    // An item of no agent, a link to no agent, a node in no group: each refused as it is written.
    expect(() => {
      addItem('nobody', 'i');
    }).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => {
      addItem('lead', 'i', 'no repeat');
    }).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => {
      addLink('lead', 'nobody');
    }).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => {
      addNode('worker', 'agent', 'no group');
    }).toThrow(/FOREIGN KEY constraint failed/);
    connection.exec('COMMIT');
    expect(
      connection
        .prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%DEFERRABLE%'")
        .all()
        .map(({ name }) => name),
    ).toEqual([]);
  });

  it('keeps a link once, its lesser end first, drawn from either end', () => {
    migrate(connection);
    addCanvas();
    addDocument();
    addNode('a');
    addNode('b');
    addLink('a', 'b', 'b');
    expect(() => {
      addLink('b', 'a');
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addLink('a', 'b');
    }).toThrow(/UNIQUE constraint failed/);
    connection.exec("DELETE FROM link WHERE a = 'a'");
    expect(() => {
      addLink('a', 'b', 'c');
    }).toThrow(/CHECK constraint failed/);
  });

  it('keeps a frame’s rows free of what only an agent has, and JSON fields valid', () => {
    migrate(connection);
    addCanvas();
    addDocument();
    addNode('team', 'frame');
    expect(() =>
      connection.prepare("UPDATE node SET role = 'Lead the team' WHERE id = 'team'").run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      connection.prepare("UPDATE node SET kind = 'group' WHERE id = 'team'").run(),
    ).toThrow(/CHECK constraint failed/);
    addNode('a');
    expect(() =>
      connection.prepare("UPDATE node SET settings = 'not JSON' WHERE id = 'a'").run(),
    ).toThrow(/CHECK constraint failed/);
    addItem('a', 'i');
    expect(() =>
      connection.prepare("UPDATE queue_item SET body = 'not JSON' WHERE id = 'i'").run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      connection.prepare("UPDATE queue_item SET kind = 'task' WHERE id = 'i'").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('holds one file review open per canvas at a time', () => {
    migrate(connection);
    addCanvas();
    addDocument();
    const raise = connection.prepare(
      `INSERT INTO file_review (id, canvas_id, file_hash, file_generation, summary, raised_at)
       VALUES (?, ?, 'h', 0, '{}', 1)`,
    );
    raise.run('first', CANVAS);
    expect(() => raise.run('second', CANVAS)).toThrow(/UNIQUE constraint failed/);
    connection
      .prepare("UPDATE file_review SET outcome = 'kept', settled_by = 'you', settled_at = 2")
      .run();
    raise.run('second', CANVAS);
  });

  it('migrates a schema-1 database to schema 2 keeping its rows but its runs’ workflows, which a schema-1 corrallm may no longer open', () => {
    const [first] = MIGRATIONS;
    if (first === undefined) throw new Error('No schema 1');
    migrate(connection, [first]);
    addCanvas();
    connection
      .prepare("UPDATE canvas SET file = '/work/team.corral', project = '/work' WHERE id = ?")
      .run(CANVAS);
    connection
      .prepare(
        "INSERT INTO conversation (canvas_id, adapter, agent_id, native_id) VALUES (?, 'codex', 'a', 'n')",
      )
      .run(CANVAS);
    connection
      .prepare('INSERT INTO run (canvas_id, state, updated_at) VALUES (?, \'{"version":2}\', 1)')
      .run(CANVAS);
    connection
      .prepare("INSERT INTO run_workflow (canvas_id, workflow, hash) VALUES (?, '{}', 'h')")
      .run(CANVAS);
    const seq = addMessage('m');
    connection
      .prepare("INSERT INTO read_position (canvas_id, party, seq) VALUES (?, 'outside:o', ?)")
      .run(CANVAS, seq);
    connection.prepare('INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, 1)').run(CANVAS);
    const rowsOf = (table: string) => connection.prepare(`SELECT * FROM ${table}`).all();
    const kept = ['canvas', 'conversation', 'run', 'message', 'read_position', 'open_canvas'];
    const before = Object.fromEntries(kept.map((table) => [table, rowsOf(table)]));

    connection.exec('PRAGMA foreign_keys = ON');
    migrate(connection, MIGRATIONS.slice(0, 2));

    expect(schemaOf(connection)).toBe(2);
    expect(minReaderOf(connection)).toBe(2);
    expect(Object.fromEntries(kept.map((table) => [table, rowsOf(table)]))).toEqual(before);
    // Its canvases have no document yet: each is read from its file as it next opens. The workflow
    // a run ran went.
    expect(rowsOf('document')).toEqual([]);
    expect(tables().map(({ name }) => name)).not.toContain('run_workflow');
    expect(addMessage('after')).toBe(seq + 1);
  });

  it('runs no migration twice', () => {
    migrate(connection);
    addCanvas();
    migrate(connection);
    expect(schemaOf(connection)).toBe(SCHEMA);
    expect(connection.prepare('SELECT count(*) AS canvases FROM canvas').get()).toEqual({
      canvases: 1,
    });
  });

  it('numbers migrations in order, never lowering the oldest schema that may read them', () => {
    MIGRATIONS.forEach((migration, i) => {
      expect(migration.version).toBeGreaterThan(MIGRATIONS[i - 1]?.version ?? 0);
      expect(migration.minReader).toBeLessThanOrEqual(migration.version);
      expect(migration.minReader).toBeGreaterThanOrEqual(MIGRATIONS[i - 1]?.minReader ?? 1);
    });
    expect(SCHEMA).toBe(MIGRATIONS.at(-1)?.version);
  });

  it('keeps nothing of a migration that fails, nor its version, but the ones before it', () => {
    const failing: Migration[] = [
      {
        version: 1,
        minReader: 1,
        sql: 'CREATE TABLE meta (id INTEGER PRIMARY KEY, min_reader INTEGER NOT NULL) STRICT',
      },
      { version: 2, minReader: 1, sql: 'CREATE TABLE half (a TEXT) STRICT; CREATE TABLE broken (' },
    ];
    expect(() => {
      migrate(connection, failing);
    }).toThrow();
    expect(connection.isTransaction).toBe(false);
    expect(schemaOf(connection)).toBe(1);
    expect(tables().map(({ name }) => name)).toEqual(['meta']);
  });

  /**
   * A migration that rebuilds canvas, which every other table refers to, as SQLite's ALTER TABLE
   * can't change it (sqlite.org/lang_altertable.html §7): here, to give each canvas a project.
   * `keep` says which canvases it copies.
   */
  const rebuildCanvas = (keep: string): Migration => ({
    version: SCHEMA + 1,
    minReader: SCHEMA + 1,
    sql: `
      CREATE TABLE canvas_new (
        id TEXT PRIMARY KEY NOT NULL,
        file TEXT UNIQUE,
        project TEXT NOT NULL DEFAULT '',
        used_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO canvas_new SELECT id, file, coalesce(project, ''), used_at FROM canvas
        WHERE ${keep};
      DROP TABLE canvas;
      ALTER TABLE canvas_new RENAME TO canvas;
      CREATE INDEX canvas_by_use ON canvas (used_at);`,
  });
  const rows = (table: string) =>
    connection.prepare(`SELECT count(*) AS rows FROM ${table}`).get()?.rows;

  it('rebuilds a table others refer to, keeping what refers to it, with foreign keys on', () => {
    connection.exec('PRAGMA foreign_keys = ON');
    migrate(connection);
    addCanvas();
    addMessage('m');

    migrate(connection, [...MIGRATIONS, rebuildCanvas('1')]);

    expect(schemaOf(connection)).toBe(SCHEMA + 1);
    expect({ canvas: rows('canvas'), message: rows('message') }).toEqual({ canvas: 1, message: 1 });
    expect(connection.prepare('SELECT project FROM canvas').get()).toEqual({ project: '' });
    expect(connection.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('refuses a migration that leaves a reference to nothing, keeping nothing of it', () => {
    connection.exec('PRAGMA foreign_keys = ON');
    migrate(connection);
    addCanvas();
    addMessage('m');

    expect(() => {
      migrate(connection, [...MIGRATIONS, rebuildCanvas('0')]);
    }).toThrow(
      `The migration to schema ${String(SCHEMA + 1)} would leave message referring to a canvas that isn’t there.`,
    );

    expect(schemaOf(connection)).toBe(SCHEMA);
    expect({ canvas: rows('canvas'), message: rows('message') }).toEqual({ canvas: 1, message: 1 });
    expect(connection.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('requires what a message must have, and keeps JSON fields valid', () => {
    migrate(connection);
    addCanvas();
    expect(() =>
      connection
        .prepare(
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, state, sent_at)
           VALUES ('m', ?, 'you', 'agent:a', 'text', 'manual', 'pending', 1)`,
        )
        .run(CANVAS),
    ).toThrow(/NOT NULL constraint failed: message\.body/);
    const id = addMessage('m');
    expect(() =>
      connection.prepare("UPDATE message SET turn = 'not JSON' WHERE seq = ?").run(id),
    ).toThrow(/CHECK constraint failed/);
    expect(() => connection.prepare("UPDATE message SET sent_at = 'soon'").run()).toThrow(
      /cannot store TEXT value in INTEGER column message\.sent_at/,
    );
  });

  it('gives each message a place that is never given again, across a reopen too', () => {
    migrate(connection);
    addCanvas();
    expect([addMessage('a'), addMessage('b'), addMessage('c')]).toEqual([1, 2, 3]);
    connection.exec('DELETE FROM message WHERE seq >= 2');
    connection.close();
    connection = connect(file);
    expect(addMessage('d')).toBe(4);
    expect(() => addMessage('a')).toThrow(/UNIQUE constraint failed: message\.id/);
  });

  it('names each table whose places are never given again', () => {
    migrate(connection);
    const numbered = connection
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(numbered).toEqual([...SEQUENCES].sort());
  });

  it('finds a canvas’s messages after a place, and a message by its id, by index', () => {
    migrate(connection);
    const plan = (sql: string) =>
      connection
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join('; ');
    expect(plan('SELECT * FROM message WHERE canvas_id = ? AND seq > ? ORDER BY seq')).toMatch(
      /USING INDEX message_by_canvas/,
    );
    expect(plan('SELECT * FROM message WHERE id = ?')).toMatch(
      /USING INDEX sqlite_autoindex_message/,
    );
  });

  it('forgets everything of a canvas it forgets', () => {
    migrate(connection);
    addCanvas();
    addCanvas('1b7f7b6f-5cc4-4d4f-9b9d-4f8f3d2f0e21');
    addMessage('m');
    connection
      .prepare(
        `INSERT INTO conversation (canvas_id, adapter, agent_id, workspace_key, native_id)
         VALUES (?, 'x', 'a', ?, 'n')`,
      )
      .run(CANVAS, PROJECT_WORKSPACE);
    addRepository();
    connection
      .prepare(
        'INSERT INTO canvas_repository (canvas_id, repository_id, generation) VALUES (?, ?, 1)',
      )
      .run(CANVAS, REPOSITORY);
    connection
      .prepare("INSERT INTO run (canvas_id, state, updated_at) VALUES (?, '{}', 1)")
      .run(CANVAS);
    connection
      .prepare("INSERT INTO read_position (canvas_id, party, seq) VALUES (?, 'you', 1)")
      .run(CANVAS);
    connection.prepare('INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, 1)').run(CANVAS);
    connection.exec('PRAGMA foreign_keys = ON');
    addDocument();
    addNode('team', 'frame');
    addNode('a', 'agent', 'team');
    addNode('b');
    addItem('a', 'r');
    addItem('a', 'i', 'r');
    addLink('a', 'b');
    connection
      .prepare(
        "INSERT INTO revision (canvas_id, rev, op, by_party, at) VALUES (?, 1, 'x', 'you', 1)",
      )
      .run(CANVAS);
    connection
      .prepare(
        "INSERT INTO change (canvas_id, rev, entity, after_data) VALUES (?, 1, 'node/a', '{}')",
      )
      .run(CANVAS);
    connection
      .prepare(
        `INSERT INTO proposal (id, canvas_id, op, args, by_party, touched, raised_at)
         VALUES ('p', ?, 'canvas.delete', '{}', 'outside:o', '{}', 1)`,
      )
      .run(CANVAS);
    connection
      .prepare(
        `INSERT INTO file_review (id, canvas_id, file_hash, file_generation, summary, raised_at)
         VALUES ('f', ?, 'h', 0, '{}', 1)`,
      )
      .run(CANVAS);
    connection.prepare('DELETE FROM canvas WHERE id = ?').run(CANVAS);
    const kept = [
      'conversation',
      'canvas_repository',
      'run',
      'message',
      'read_position',
      'open_canvas',
      'document',
      'node',
      'link',
      'queue_item',
      'revision',
      'change',
      'proposal',
      'file_review',
    ];
    for (const table of kept) {
      expect(connection.prepare(`SELECT count(*) AS rows FROM ${table}`).get(), table).toEqual({
        rows: 0,
      });
    }
    expect(connection.prepare('SELECT count(*) AS rows FROM canvas').get()).toEqual({ rows: 1 });
    // A repository is the profile's, whichever canvases pick it.
    expect(rows('repository')).toBe(1);
  });
});

const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const OTHER_CANVAS = '1b7f7b6f-5cc4-4d4f-9b9d-4f8f3d2f0e21';
const W1 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';
const W2 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c52';
const W3 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c53';
const W4 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c54';
const OID = 'a'.repeat(40);
const ACTIVE = ['creating', 'setup', 'ready', 'missing', 'error'];
const KEPT = ['retained', 'removing'];

function addRepository(id = REPOSITORY): void {
  connection
    .prepare(
      `INSERT INTO repository
         (id, picked_root, real_root, common_dir, identity, root_kind, owned_root, generation)
       VALUES (?, '/work/app', '/work/app', '/work/app/.git', 'identity', 'project',
         '/work/app/.corral/worktrees/p', 1)`,
    )
    .run(id);
}

/** Adds a workspace of the canvas's repository, its checkout and branch its own unless given. */
function addWorktree(
  id: string,
  owner: string,
  {
    state = 'ready',
    canvas = CANVAS,
    branch = `refs/heads/corrallm/p/${id}`,
    path: at = `/work/app/.corral/worktrees/p/${id}`,
    forkedFrom = null,
  }: {
    state?: string;
    canvas?: string;
    branch?: string;
    path?: string;
    forkedFrom?: string | null;
  } = {},
): void {
  connection
    .prepare(
      `INSERT INTO worktree (id, canvas_id, repository_id, owner_key, path, branch_ref,
         base_checkout, base_oid, forked_from, state, generation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '/work/app', ?, ?, ?, 1, 1)`,
    )
    .run(id, canvas, REPOSITORY, owner, at, branch, OID, forkedFrom, state);
}

function bind(agent: string, workspace: string, canvas = CANVAS): void {
  connection
    .prepare(
      'INSERT INTO agent_worktree (canvas_id, agent_id, workspace_id, generation) VALUES (?, ?, ?, 1)',
    )
    .run(canvas, agent, workspace);
}

function addJob(id: string, workspace: string, kind: string, outcome: string | null = null): void {
  connection
    .prepare(
      `INSERT INTO worktree_job (id, workspace_id, kind, phase, generation, payload, intent_hash, outcome,
         created_at, updated_at)
       VALUES (?, ?, ?, 'intent', 1, '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ?, 1, 1)`,
    )
    .run(id, workspace, kind, outcome);
}

const count = (table: string): unknown =>
  connection.prepare(`SELECT count(*) AS rows FROM ${table}`).get()?.rows;

describe('schema 3: workspaces', () => {
  beforeEach(() => {
    migrate(connection);
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
    addRepository();
  });

  it('keeps one active workspace per owner of a canvas’s repository, and any number kept or being removed', () => {
    for (const state of ACTIVE) {
      addWorktree(W1, 'group/team', { state });
      for (const other of ACTIVE) {
        expect(() => {
          addWorktree(W2, 'group/team', { state: other });
        }, `${state} then ${other}`).toThrow(/UNIQUE constraint failed/);
      }
      connection.prepare('DELETE FROM worktree WHERE id = ?').run(W1);
    }
    addWorktree(W1, 'group/team', { state: 'retained' });
    addWorktree(W2, 'group/team', { state: 'removing' });
    addWorktree(W3, 'group/team', { state: 'ready' });
    // Another owner, or another canvas's group of the same id, has its own.
    addWorktree(W4, 'agent/team', { state: 'ready' });
    connection.prepare('DELETE FROM worktree WHERE id = ?').run(W4);
    addCanvas(OTHER_CANVAS);
    addWorktree(W4, 'group/team', { canvas: OTHER_CANVAS });
    // A kept one may not become active again while another is.
    for (const state of ACTIVE) {
      expect(() =>
        connection.prepare('UPDATE worktree SET state = ? WHERE id = ?').run(state, W1),
      ).toThrow(/UNIQUE constraint failed/);
    }
    for (const state of KEPT) {
      connection.prepare('UPDATE worktree SET state = ? WHERE id = ?').run(state, W3);
    }
    expect(() =>
      connection.prepare("UPDATE worktree SET state = 'gone' WHERE id = ?").run(W1),
    ).toThrow(/CHECK constraint failed/);
    expect(() => {
      addWorktree('9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c55', 'team');
    }).toThrow(/CHECK constraint failed/);
  });

  it('never gives a branch of a repository, or a checkout, to two workspaces', () => {
    addWorktree(W1, 'agent/a', { state: 'retained', branch: 'refs/heads/shared' });
    expect(() => {
      addWorktree(W2, 'agent/b', { branch: 'refs/heads/shared' });
    }).toThrow(/UNIQUE constraint failed: worktree\.repository_id, worktree\.branch_ref/);
    expect(() => {
      addWorktree(W2, 'agent/b', { path: `/work/app/.corral/worktrees/p/${W1}` });
    }).toThrow(/UNIQUE constraint failed: worktree\.path/);
    addWorktree(W2, 'agent/b');
  });

  it('keeps a canvas that owns a workspace, in any state, until its last workspace record goes', () => {
    for (const state of [...ACTIVE, ...KEPT]) {
      addWorktree(W1, 'agent/a', { state });
      expect(
        () => connection.prepare('DELETE FROM canvas WHERE id = ?').run(CANVAS),
        state,
      ).toThrow(/FOREIGN KEY constraint failed/);
      connection.prepare('DELETE FROM worktree WHERE id = ?').run(W1);
    }
    connection
      .prepare(
        'INSERT INTO canvas_repository (canvas_id, repository_id, generation) VALUES (?, ?, 1)',
      )
      .run(CANVAS, REPOSITORY);
    connection.prepare('DELETE FROM canvas WHERE id = ?').run(CANVAS);
    expect({ canvases: count('canvas'), bound: count('canvas_repository') }).toEqual({
      canvases: 0,
      bound: 0,
    });
    // Nor is a repository forgotten while a canvas or a workspace refers to it.
    addCanvas();
    connection
      .prepare(
        'INSERT INTO canvas_repository (canvas_id, repository_id, generation) VALUES (?, ?, 1)',
      )
      .run(CANVAS, REPOSITORY);
    expect(() => connection.prepare('DELETE FROM repository').run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    // A canvas whose project folder isn't a repository keeps its generation, with none.
    connection.prepare('UPDATE canvas_repository SET repository_id = NULL, generation = 2').run();
    addWorktree(W1, 'agent/a');
    expect(() => connection.prepare('DELETE FROM repository').run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('keeps an agent’s binding when its node goes, and its workspace while a binding refers to it', () => {
    addDocument();
    addNode('a');
    addWorktree(W1, 'agent/a');
    bind('a', W1);
    connection.prepare("DELETE FROM node WHERE id = 'a'").run();
    expect(count('agent_worktree')).toBe(1);
    expect(() => connection.prepare('DELETE FROM worktree WHERE id = ?').run(W1)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    // Only a workspace of its own canvas.
    addCanvas(OTHER_CANVAS);
    addWorktree(W2, 'agent/a', { canvas: OTHER_CANVAS });
    expect(() => {
      bind('b', W2);
    }).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => {
      bind('b', 'no workspace');
    }).toThrow(/FOREIGN KEY constraint failed/);
    // A plan waits beside it: the owner it is for, and its generation, past the active one.
    connection
      .prepare(
        "UPDATE agent_worktree SET desired_generation = 2, desired_owner_key = 'group/team' WHERE agent_id = 'a'",
      )
      .run();
    for (const [generation, owner] of [
      [2, null],
      [null, 'group/team'],
      [1, 'group/team'],
      [2, 'team'],
    ] as const) {
      expect(
        () =>
          connection
            .prepare(
              "UPDATE agent_worktree SET desired_generation = ?, desired_owner_key = ? WHERE agent_id = 'a'",
            )
            .run(generation, owner),
        `${String(generation)} ${String(owner)}`,
      ).toThrow(/CHECK constraint failed/);
    }
    connection.prepare('DELETE FROM agent_worktree').run();
    connection.prepare('DELETE FROM worktree WHERE id = ?').run(W1);
  });

  it('keeps one open job of a kind per workspace, and its jobs and setup go with it', () => {
    addWorktree(W1, 'agent/a');
    addWorktree(W2, 'agent/b', { forkedFrom: W1 });
    addJob('j1', W1, 'create');
    expect(() => {
      addJob('j2', W1, 'create');
    }).toThrow(/UNIQUE constraint failed/);
    addJob('j2', W1, 'remove');
    connection.prepare("UPDATE worktree_job SET outcome = 'done' WHERE id = 'j1'").run();
    addJob('j3', W1, 'create');
    expect(() =>
      connection.prepare("UPDATE worktree_job SET payload = 'not JSON' WHERE id = 'j3'").run(),
    ).toThrow(/CHECK constraint failed/);
    connection
      .prepare(
        `INSERT INTO worktree_setup (workspace_id, generation, source, spec_hash,
           copy_manifest_hash, state)
         VALUES (?, 1, 'none', ?, ?, 'pending')`,
      )
      .run(W1, 'b'.repeat(64), 'c'.repeat(64));
    connection.prepare('DELETE FROM worktree WHERE id = ?').run(W1);
    expect({ jobs: count('worktree_job'), setups: count('worktree_setup') }).toEqual({
      jobs: 0,
      setups: 0,
    });
    // What was forked from it no longer names it.
    expect(connection.prepare('SELECT forked_from FROM worktree WHERE id = ?').get(W2)).toEqual({
      forked_from: null,
    });
  });

  it('keeps what a setup runs consistent with where it came from and who allowed it', () => {
    addWorktree(W1, 'agent/a');
    const offer = connection.prepare(
      `INSERT OR REPLACE INTO worktree_setup (workspace_id, generation, command_snapshot, source,
         spec_hash, copy_manifest_hash, state, approved_by, approved_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const hash = 'b'.repeat(64);
    offer.run(W1, 'pnpm install', 'detected', hash, hash, 'pending', null, null);
    offer.run(W1, 'pnpm install', 'detected', hash, hash, 'running', 'you', 2);
    offer.run(W1, null, 'none', hash, hash, 'skipped', null, null);
    for (const [command, source, state, by, at] of [
      [null, 'detected', 'pending', null, null],
      ['pnpm install', 'none', 'pending', null, null],
      ['pnpm install', 'repository', 'pending', null, null],
      ['pnpm install', 'detected', 'started', null, null],
      ['pnpm install', 'detected', 'running', 'you', null],
      // Nothing runs, nor ran, unallowed.
      ['pnpm install', 'detected', 'running', null, null],
      ['pnpm install', 'detected', 'done', null, null],
      ['pnpm install', 'detected', 'interrupted', null, null],
    ] as const) {
      expect(() => offer.run(W1, command, source, hash, hash, state, by, at)).toThrow(
        /CHECK constraint failed/,
      );
    }
    const project = connection.prepare(
      `INSERT OR REPLACE INTO project_setup (repository_id, command, shell_kind, always_spec_hash,
         changed_at)
       VALUES (?, ?, ?, ?, 1)`,
    );
    project.run(REPOSITORY, null, null, hash);
    project.run(REPOSITORY, 'make setup', 'posix', null);
    expect(() => project.run(REPOSITORY, 'make setup', null, null)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => project.run(REPOSITORY, null, 'posix', null)).toThrow(/CHECK constraint failed/);
    expect(() => project.run('no repository', null, null, null)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('keeps an agent’s conversation in each workspace it ran in apart', () => {
    const remember = connection.prepare(
      `INSERT INTO conversation (canvas_id, adapter, agent_id, workspace_key, native_id)
       VALUES (?, 'x', 'a', ?, ?)`,
    );
    remember.run(CANVAS, PROJECT_WORKSPACE, 'in the project folder');
    remember.run(CANVAS, W1, 'in its worktree');
    expect(() => remember.run(CANVAS, W1, 'again')).toThrow(/UNIQUE constraint failed/);
    expect(() => remember.run(CANVAS, '', 'nowhere')).toThrow(/CHECK constraint failed/);
  });
});

describe('migration 3', () => {
  it('migrates a schema-2 database to schema 3 keeping every row, its conversations in the picked project folder, which a schema-2 corrallm may no longer open', () => {
    migrate(connection, MIGRATIONS.slice(0, 2));
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
    connection
      .prepare("UPDATE canvas SET file = '/work/team.corral', project = '/work' WHERE id = ?")
      .run(CANVAS);
    addCanvas(OTHER_CANVAS);
    const remember = connection.prepare(
      `INSERT INTO conversation (canvas_id, adapter, agent_id, native_id, role_fingerprint)
       VALUES (?, ?, ?, ?, ?)`,
    );
    remember.run(CANVAS, 'claude-code', 'lead', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11', 'none');
    remember.run(CANVAS, 'codex', 'lead', '0199a3f0-1234-7000-8000-123456789abc', 'f'.repeat(64));
    remember.run(CANVAS, 'codex', 'worker', 'thread', null);
    // Kept as it was, though no corrallm would resume it.
    remember.run(OTHER_CANVAS, 'codex', 'a', '--resume', null);
    connection
      .prepare('INSERT INTO run (canvas_id, state, updated_at) VALUES (?, \'{"version":2}\', 1)')
      .run(CANVAS);
    const seq = addMessage('m');
    connection
      .prepare("INSERT INTO read_position (canvas_id, party, seq) VALUES (?, 'outside:o', ?)")
      .run(CANVAS, seq);
    connection.prepare('INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, 1)').run(CANVAS);
    addDocument();
    addNode('team', 'frame');
    addNode('lead', 'agent', 'team');
    addNode('worker');
    addItem('lead', 'r');
    addItem('lead', 'i', 'r');
    addLink('lead', 'worker');
    connection
      .prepare(
        "INSERT INTO revision (canvas_id, rev, op, by_party, at) VALUES (?, 1, 'x', 'you', 1)",
      )
      .run(CANVAS);
    connection
      .prepare(
        "INSERT INTO change (canvas_id, rev, entity, after_data) VALUES (?, 1, 'node/lead', '{}')",
      )
      .run(CANVAS);
    connection
      .prepare(
        `INSERT INTO proposal (id, canvas_id, op, args, by_party, touched, raised_at)
         VALUES ('p', ?, 'canvas.delete', '{}', 'outside:o', '{}', 1)`,
      )
      .run(CANVAS);
    connection
      .prepare(
        `INSERT INTO file_review (id, canvas_id, file_hash, file_generation, summary, raised_at)
         VALUES ('f', ?, 'h', 0, '{}', 1)`,
      )
      .run(CANVAS);
    const rowsOf = (table: string) => connection.prepare(`SELECT * FROM ${table}`).all();
    const kept = [
      'canvas',
      'run',
      'message',
      'read_position',
      'open_canvas',
      'document',
      'node',
      'link',
      'queue_item',
      'revision',
      'change',
      'proposal',
      'file_review',
    ];
    const before = Object.fromEntries(kept.map((table) => [table, rowsOf(table)]));
    const conversations = () =>
      connection.prepare('SELECT * FROM conversation ORDER BY canvas_id, adapter, agent_id').all();
    const talked = conversations();

    migrate(connection, MIGRATIONS.slice(0, 3));

    expect(schemaOf(connection)).toBe(3);
    expect(minReaderOf(connection)).toBe(3);
    expect(Object.fromEntries(kept.map((table) => [table, rowsOf(table)]))).toEqual(before);
    expect(conversations()).toEqual(
      talked.map((row) => ({ ...row, workspace_key: PROJECT_WORKSPACE })),
    );
    for (const table of [
      'repository',
      'canvas_repository',
      'worktree',
      'agent_worktree',
      'worktree_job',
      'worktree_setup',
      'project_setup',
    ]) {
      expect(count(table), table).toBe(0);
    }
    expect(addMessage('after')).toBe(seq + 1);
  });
});

/** A row of `message` as a corrallm of schema 3 wrote it (MessageTable.keep at 767a382). */
function keep3(
  row: Partial<Record<string, string | number | null>> & { id: string },
  canvas = CANVAS,
): number {
  const columns = {
    canvas_id: canvas,
    from_party: 'you',
    to_party: 'agent:a',
    kind: 'text',
    body: 'Hello',
    state: 'replied',
    sent_at: 1,
    ...row,
  };
  const names = Object.keys(columns);
  return connection
    .prepare(
      `INSERT INTO message (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
       RETURNING seq`,
    )
    .get(...Object.values(columns))?.seq as number;
}

/** A canvas's run as a corrallm of schema 3 journaled it (RunJournal.keep at 767a382). */
function journal3(state: unknown, canvas = CANVAS, updatedAt = 5000): void {
  connection
    .prepare('INSERT INTO run (canvas_id, state, updated_at) VALUES (?, ?, ?)')
    .run(canvas, typeof state === 'string' ? state : JSON.stringify(state), updatedAt);
}

/** A saved run as the engine of schema 3 kept one (src/main/core/engine/run/checkpoint.ts). */
const SAVED_RUN = {
  version: 2,
  run: { running: false, paused: true, agents: { a: { status: 'done', outcomes: {} } } },
  replies: [],
  held: [],
  arrived: [],
  ended: [],
  past: [],
  due: [],
  usageDecided: [],
  warned: [],
};

/** Every column of each message of the canvas, in their order, as JSON columns read back. */
const messagesOf = (canvas = CANVAS) =>
  connection
    .prepare('SELECT * FROM message WHERE canvas_id = ? ORDER BY seq')
    .all(canvas)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          ['task', 'turn', 'delivery', 'withdrawal', 'display'].includes(key) &&
          typeof value === 'string'
            ? (JSON.parse(value) as unknown)
            : value,
        ]),
      ),
    );

const stateOf = (canvas = CANVAS): unknown => {
  const state = connection.prepare('SELECT state FROM run WHERE canvas_id = ?').get(canvas)?.state;
  return typeof state === 'string' ? (JSON.parse(state) as unknown) : state;
};

describe('migration 4', () => {
  beforeEach(() => {
    migrate(connection, MIGRATIONS.slice(0, 3));
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
  });

  it('classifies each message by what made it, moving a resend’s marker to resend_of, which a schema-3 corrallm may no longer open', () => {
    const original = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
    const imaged = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12';
    keep3({
      id: original,
      from_party: 'outside:orchestrator',
      delivery: '{"at":1,"as":"n1","attempt":1}',
    });
    keep3({ id: imaged, delivery: '{"at":1,"as":"n2","attempt":1}' });
    // Resends, as Interrupt and resend marked them (PR #31): by their notice key and reply link.
    keep3({
      id: 'resent',
      from_party: 'outside:orchestrator',
      state: 'pending',
      reply_to: original,
      told: `resend:${original}`,
    });
    keep3({
      id: 'resent with images',
      state: 'pending',
      reply_to: imaged,
      told: `resend:${imaged}:images`,
    });
    // What only looks like one keeps its link: its key names another message.
    keep3({
      id: 'a reply',
      from_party: 'agent:a',
      to_party: 'you',
      reply_to: original,
      told: 'resend:else',
    });
    keep3({
      id: 'told',
      from_party: 'corrallm',
      to_party: 'outside:orchestrator',
      kind: 'notice',
      state: 'delivered',
      reply_to: original,
      told: `resent:${original}`,
    });
    keep3({ id: 'yours', state: 'pending' });
    const before = messagesOf();

    migrate(connection, MIGRATIONS.slice(0, 4));

    expect(schemaOf(connection)).toBe(4);
    expect(minReaderOf(connection)).toBe(4);
    const unchanged = (id: string) => ({
      ...before.find((row) => row.id === id),
      display: null,
      resend_of: null,
    });
    expect(messagesOf()).toEqual([
      { ...unchanged(original), origin: 'party' },
      { ...unchanged(imaged), origin: 'manual' },
      { ...unchanged('resent'), origin: 'resend', reply_to: null, told: null, resend_of: original },
      {
        ...unchanged('resent with images'),
        origin: 'resend',
        reply_to: null,
        told: null,
        resend_of: imaged,
        display: { requiresImages: true },
      },
      { ...unchanged('a reply'), origin: 'party' },
      { ...unchanged('told'), origin: 'party' },
      { ...unchanged('yours'), origin: 'manual' },
    ]);
  });

  it('gives no place in the order again, the newest deleted ones’ included', () => {
    keep3({ id: 'first' });
    const last = keep3({ id: 'second' });
    connection.prepare("DELETE FROM message WHERE id = 'second'").run();
    migrate(connection);
    expect(addMessage('third')).toBe(last + 1);
    expect(
      connection.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'message'").get(),
    ).toEqual({ seq: last + 1 });
  });

  it('keeps each run in its own envelope, its submissions your messages, and leaves one it can’t read as it was', () => {
    const OTHER = OTHER_CANVAS;
    const BROKEN = '2c8e8c7f-6dd5-4e5f-8aaf-5a6b7c8d9e32';
    const REFUSED = '3d9f9d80-7ee6-4f60-9bb0-6b7c8d9e0f43';
    addCanvas(OTHER);
    addCanvas(BROKEN);
    addCanvas(REFUSED);
    const submissions = {
      version: 1,
      agents: [
        {
          id: 'a',
          submissions: [
            {
              id: 'native-1',
              text: 'Fix it',
              status: 'completed',
              after: 'plan',
              task: { agent: 'a', item: 'plan' },
              result: { status: 'completed', reason: 'completed' },
            },
            {
              id: 'native-2',
              text: 'Explain',
              status: 'cancelled',
              result: { status: 'cancelled', reason: 'interrupted' },
            },
            { id: 'native-3', text: 'Explain', status: 'completed', retryOf: 'native-2' },
            { id: 'native-4', text: 'Slow', status: 'running', after: 'plan' },
            { id: 'native-5', text: 'Then this', status: 'queued' },
            {
              id: 'native-6',
              text: 'Cut off before',
              status: 'cancelled',
              unresolved: true,
              result: {
                status: 'cancelled',
                reason: 'interrupted',
                message: 'Unresolved after restart; resume the queue to continue.',
              },
            },
          ],
        },
      ],
    };
    journal3({ version: 2, state: SAVED_RUN, messages: submissions });
    journal3(
      {
        version: 2,
        state: SAVED_RUN,
        messages: { version: 1, agents: [] },
        saveError: 'Too large',
      },
      OTHER,
      7000,
    );
    journal3({ saveError: 'Too large' }, REFUSED);
    // A status no corrallm kept: its run can't be restored, so it is left for the journal to say so.
    const broken = JSON.stringify({
      version: 2,
      state: SAVED_RUN,
      messages: {
        version: 1,
        agents: [{ id: 'a', submissions: [{ id: 'x', text: 'x', status: 'lost' }] }],
      },
    });
    journal3(broken, BROKEN);

    migrate(connection, MIGRATIONS.slice(0, 4));

    expect(stateOf()).toEqual({ format: 3, run: SAVED_RUN });
    expect(stateOf(OTHER)).toEqual({ format: 3, run: SAVED_RUN, saveError: 'Too large' });
    expect(stateOf(REFUSED)).toEqual({ format: 3, saveError: 'Too large' });
    expect(stateOf(BROKEN)).toEqual(JSON.parse(broken));
    expect(messagesOf(BROKEN)).toEqual([]);
    expect(connection.prepare('SELECT updated_at FROM run ORDER BY canvas_id').all()).toEqual([
      { updated_at: 5000 },
      { updated_at: 7000 },
      { updated_at: 5000 },
      { updated_at: 5000 },
    ]);
    const rows = messagesOf();
    const unresolved = {
      status: 'cancelled',
      reason: 'interrupted',
      message: 'Unresolved after restart; resume the queue to continue.',
    };
    const yours = (as: string) => ({
      canvas_id: CANVAS,
      from_party: 'you',
      to_party: 'agent:a',
      kind: 'text',
      reply_to: null,
      task: null,
      delivery: { at: 5000, as, attempt: 1 },
      by_party: null,
      sent_at: 5000,
      told: null,
      withdrawal: null,
    });
    expect(rows).toEqual([
      {
        ...yours('native-1'),
        seq: expect.any(Number) as number,
        id: expect.any(String) as string,
        origin: 'manual',
        body: 'Fix it',
        display: { after: 'plan', task: { agent: 'a', item: 'plan' } },
        resend_of: null,
        turn: { status: 'completed', reason: 'completed' },
        state: 'replied',
      },
      {
        ...yours('native-2'),
        seq: expect.any(Number) as number,
        id: expect.any(String) as string,
        origin: 'manual',
        body: 'Explain',
        display: null,
        resend_of: null,
        turn: { status: 'cancelled', reason: 'interrupted' },
        state: 'replied',
      },
      {
        ...yours('native-3'),
        seq: expect.any(Number) as number,
        id: expect.any(String) as string,
        origin: 'resend',
        body: 'Explain',
        display: null,
        resend_of: rows[1]?.id,
        // A record that kept no result keeps its status, with that status's plainest reason.
        turn: { status: 'completed', reason: 'completed' },
        state: 'replied',
      },
      // What went on, or waited, as the profile closed is unresolved, never sent again.
      {
        ...yours('native-4'),
        seq: expect.any(Number) as number,
        id: expect.any(String) as string,
        origin: 'manual',
        body: 'Slow',
        display: { after: 'plan' },
        resend_of: null,
        turn: unresolved,
        state: 'unresolved',
      },
      {
        ...yours('native-5'),
        seq: expect.any(Number) as number,
        id: expect.any(String) as string,
        origin: 'manual',
        body: 'Then this',
        display: null,
        resend_of: null,
        turn: unresolved,
        state: 'unresolved',
      },
      {
        ...yours('native-6'),
        seq: expect.any(Number) as number,
        id: expect.any(String) as string,
        origin: 'manual',
        body: 'Cut off before',
        display: null,
        resend_of: null,
        turn: unresolved,
        state: 'unresolved',
      },
    ]);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(6);
    const places = rows.map(({ seq }) => seq as number);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  it('gives a submission a message of its own only where none represents it yet', () => {
    const delivered = '4e0a0e91-8ff7-4071-8cc1-7c8d9e0f1a54';
    const own = '5f1b1fa2-9008-4182-9dd2-8d9e0f1a2b65';
    // Your message the core delivered under the submission's native id, and one sent under its own.
    keep3({ id: delivered, state: 'replied', delivery: '{"at":1,"as":"native-1","attempt":1}' });
    keep3({ id: own, state: 'replied' });
    // Another agent's message under the same native id represents only that agent's.
    keep3({ id: 'to b', to_party: 'agent:b', delivery: '{"at":1,"as":"native-2","attempt":1}' });
    journal3({
      version: 2,
      state: SAVED_RUN,
      messages: {
        version: 1,
        agents: [
          {
            id: 'a',
            submissions: [
              { id: 'native-1', text: 'Hello', status: 'completed', after: 'plan' },
              { id: own, text: 'Hello', status: 'completed' },
              { id: 'native-2', text: 'Hello', status: 'completed' },
            ],
          },
        ],
      },
    });

    migrate(connection);

    const rows = messagesOf();
    // Each represented one keeps its own record, which only gains where its submission showed.
    expect(rows.map(({ id, display, state }) => ({ id, display, state }))).toEqual([
      { id: delivered, display: { after: 'plan' }, state: 'replied' },
      { id: own, display: null, state: 'replied' },
      { id: 'to b', display: null, state: 'replied' },
      { id: expect.any(String) as string, display: null, state: 'replied' },
    ]);
    expect(rows[3]).toMatchObject({ to_party: 'agent:a', delivery: { as: 'native-2' } });
  });

  it('keeps a long submission’s body within what a message holds, its whole text where a view shows it', () => {
    // At most 16 KiB of UTF-8 in a message's body (MAX_MESSAGE_BYTES); a submission held more.
    const text = 'é'.repeat(16 * 1024);
    journal3({
      version: 2,
      state: SAVED_RUN,
      messages: {
        version: 1,
        agents: [
          {
            id: 'a',
            submissions: [{ id: 'native-1', text, status: 'completed', after: 'plan' }],
          },
        ],
      },
    });

    migrate(connection);

    const [row] = messagesOf();
    const body = String(row?.body);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024);
    expect(text.startsWith(body.slice(0, 100))).toBe(true);
    expect(row?.display).toEqual({ after: 'plan', text });
  });

  it('runs its conversion only within its own migration', () => {
    const [, , , fourth] = MIGRATIONS;
    const convert = fourth?.convert;
    if (convert === undefined) throw new Error('Migration 4 converts nothing');
    // Outside a transaction, at schema 3.
    expect(() => {
      convert(connection);
    }).toThrow('Migration 4’s conversion runs only within migration 4.');
    migrate(connection);
    // At schema 4, within a transaction.
    connection.exec('BEGIN');
    try {
      expect(() => {
        convert(connection);
      }).toThrow('Migration 4’s conversion runs only within migration 4.');
    } finally {
      connection.exec('ROLLBACK');
    }
  });

  it('keeps nothing of migration 4 when its conversion fails, its message table’s rebuild included', () => {
    keep3({ id: 'kept' });
    journal3({ version: 2, state: SAVED_RUN, messages: { version: 1, agents: [] } });
    connection.exec(
      "CREATE TRIGGER refuse BEFORE UPDATE ON run BEGIN SELECT RAISE(ABORT, 'The disk is full'); END",
    );
    const before = messagesOf();

    expect(() => {
      migrate(connection);
    }).toThrow('The disk is full');

    expect(schemaOf(connection)).toBe(3);
    expect(minReaderOf(connection)).toBe(3);
    expect(messagesOf()).toEqual(before);
    expect(stateOf()).toEqual({
      version: 2,
      state: SAVED_RUN,
      messages: { version: 1, agents: [] },
    });
    connection.exec('DROP TRIGGER refuse');
    migrate(connection, MIGRATIONS.slice(0, 4));
    expect(schemaOf(connection)).toBe(4);
  });
});

describe('schema 4: messages', () => {
  beforeEach(() => {
    migrate(connection);
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
  });

  it('requires how each message came to be, and keeps what a view shows of it valid', () => {
    const add = connection.prepare(
      `INSERT INTO message (id, canvas_id, from_party, to_party, kind, origin, body, display,
         resend_of, state, sent_at)
       VALUES (?, ?, 'you', 'agent:a', 'text', ?, 'Hello', ?, ?, 'pending', 1)`,
    );
    add.run('manual', CANVAS, 'manual', '{"after":"plan"}', null);
    add.run('resend', CANVAS, 'resend', '{"requiresImages":true}', 'manual');
    // A resend whose original wasn't kept.
    add.run('orphan', CANVAS, 'resend', null, null);
    for (const [id, origin, display, resendOf] of [
      ['no origin', null, null, null],
      ['another origin', 'typed', null, null],
      ['not JSON', 'manual', 'after plan', null],
      ['resends, not one', 'manual', null, 'manual'],
    ] as const) {
      expect(() => add.run(id, CANVAS, origin, display, resendOf), id).toThrow(/constraint failed/);
    }
  });
});

const MERGE_JOB = '5e3c1a0b-7d2f-4a61-9b8e-0c1d2e3f4a51';
const OTHER_JOB = '5e3c1a0b-7d2f-4a61-9b8e-0c1d2e3f4a52';
const REQUEST = '6f4d2b1c-8e3a-4b72-8c9f-1d2e3f4a5b61';
const OTHER_REQUEST = '6f4d2b1c-8e3a-4b72-8c9f-1d2e3f4a5b62';

/** Records a merge job of the canvas's repository (B9b §9 C8), as the merge service would. */
function addMergeJob(
  id: string,
  {
    canvas = CANVAS,
    workspace = W1,
    caller = 'you',
    request = REQUEST,
    intent = '{"version":1}',
    phase = 'installing',
    outcome = null,
  }: {
    canvas?: string;
    workspace?: string;
    caller?: string;
    request?: string;
    intent?: string;
    phase?: string;
    outcome?: string | null;
  } = {},
): void {
  connection
    .prepare(
      `INSERT INTO merge_job (id, canvas_id, agent_id, workspace_id, repository_id, caller_key,
         request_id, intent, intent_hash, phase, outcome, created_at, updated_at)
       VALUES (?, ?, 'a', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      id,
      canvas,
      workspace,
      REPOSITORY,
      caller,
      request,
      intent,
      'c'.repeat(64),
      phase,
      outcome,
    );
}

describe('schema 5: merge jobs', () => {
  beforeEach(() => {
    migrate(connection);
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
    addRepository();
  });

  it('keeps one merge going on per repository, and any number settled', () => {
    addMergeJob(MERGE_JOB);
    expect(() => {
      addMergeJob(OTHER_JOB, { request: OTHER_REQUEST });
    }).toThrow(/UNIQUE constraint failed: merge_job\.repository_id/);
    for (const outcome of ['merged', 'refused', 'interrupted', 'held', 'superseded']) {
      connection.prepare('UPDATE merge_job SET outcome = ? WHERE id = ?').run(outcome, MERGE_JOB);
    }
    addMergeJob(OTHER_JOB, { request: OTHER_REQUEST });
    expect(count('merge_job')).toBe(2);
  });

  it('answers a caller’s request once: another caller may use the same id', () => {
    addMergeJob(MERGE_JOB, { outcome: 'merged' });
    expect(() => {
      addMergeJob(OTHER_JOB, { outcome: 'merged' });
    }).toThrow(/UNIQUE constraint failed: merge_job\.caller_key, merge_job\.request_id/);
    addMergeJob(OTHER_JOB, { caller: 'token:0f1e2d3c-4b5a-4968-8776-655443322110' });
  });

  it('keeps its intent valid JSON, and only its phases and outcomes', () => {
    expect(() => {
      addMergeJob(MERGE_JOB, { intent: 'not JSON' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addMergeJob(MERGE_JOB, { phase: 'merging' });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      addMergeJob(MERGE_JOB, { outcome: 'done' });
    }).toThrow(/CHECK constraint failed/);
    for (const phase of ['installing', 'installed', 'published', 'done']) {
      connection.prepare('DELETE FROM merge_job').run();
      addMergeJob(MERGE_JOB, { phase });
    }
  });

  it('outlives its workspace’s cleanup, goes with its canvas, and keeps its repository', () => {
    addWorktree(W1, 'agent/a');
    addMergeJob(MERGE_JOB, { outcome: 'merged' });
    connection.prepare('DELETE FROM worktree WHERE id = ?').run(W1);
    expect(count('merge_job')).toBe(1);
    expect(() => connection.prepare('DELETE FROM repository').run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    connection.prepare('DELETE FROM canvas WHERE id = ?').run(CANVAS);
    expect(count('merge_job')).toBe(0);
  });
});

describe('migration 5', () => {
  it('adds merge jobs to a schema-4 database keeping every row, which a schema-4 corrallm may no longer open', () => {
    migrate(connection, MIGRATIONS.slice(0, 4));
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
    addMessage('kept');
    addRepository();
    addWorktree(W1, 'agent/a');
    bind('a', W1);
    addJob('j1', W1, 'create', 'done');
    const kept = ['canvas', 'message', 'repository', 'worktree', 'agent_worktree', 'worktree_job'];
    const rowsOf = (table: string) => connection.prepare(`SELECT * FROM ${table}`).all();
    const before = Object.fromEntries(kept.map((table) => [table, rowsOf(table)]));

    migrate(connection, MIGRATIONS.slice(0, 5));

    expect(schemaOf(connection)).toBe(5);
    expect(minReaderOf(connection)).toBe(5);
    expect(Object.fromEntries(kept.map((table) => [table, rowsOf(table)]))).toEqual(before);
    expect(count('merge_job')).toBe(0);
    addMergeJob(MERGE_JOB);
  });
});

/** A native prompt's decision, value-free, as the owner records it (B13 §9.2 C9). */
const SETTLED = JSON.stringify({
  v: 1,
  need: 'prompt/a/1/0f1e2d3c-4b5a-4968-8776-655443322110',
  prompt: { id: '0f1e2d3c-4b5a-4968-8776-655443322110', kind: 'approval', subject: 'command' },
  outcome: { type: 'choice', value: 'yes', hint: 'allow_once' },
});

describe('schema 7: a message’s settled decision', () => {
  beforeEach(() => {
    migrate(connection);
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
  });

  it('keeps a record’s settled decision as valid JSON, or none', () => {
    const seq = addMessage('record');
    const settle = connection.prepare('UPDATE message SET settled = ? WHERE seq = ?');
    settle.run(SETTLED, seq);
    expect(connection.prepare('SELECT settled FROM message WHERE seq = ?').get(seq)).toEqual({
      settled: SETTLED,
    });
    settle.run(null, seq);
    expect(() => settle.run('not JSON', seq)).toThrow(/CHECK constraint failed/);
  });
});

describe('migration 7', () => {
  it('adds a settled decision to every message of the schema before it, keeping every row, and the oldest schema that may read them', () => {
    const before7 = MIGRATIONS.filter(({ version }) => version < 7);
    migrate(connection, before7);
    connection.exec('PRAGMA foreign_keys = ON');
    addCanvas();
    addMessage('kept');
    const before = connection.prepare('SELECT * FROM message').all();
    const reader = minReaderOf(connection);

    migrate(connection);

    expect(schemaOf(connection)).toBe(7);
    // A column only: a corrallm of the schema before still reads and writes its own columns.
    expect(reader).toBe(before7.at(-1)?.minReader);
    expect(minReaderOf(connection)).toBe(reader);
    expect(connection.prepare('SELECT * FROM message').all()).toEqual(
      before.map((row) => ({ ...row, settled: null })),
    );
  });
});
