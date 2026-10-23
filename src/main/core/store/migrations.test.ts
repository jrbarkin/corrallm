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
function addMessage(id: string, canvas = CANVAS): number {
  const row = connection
    .prepare(
      `INSERT INTO message (id, canvas_id, from_party, to_party, kind, body, state, sent_at)
       VALUES (?, ?, 'you', 'agent:a', 'text', 'Hello', 'pending', 1) RETURNING seq`,
    )
    .get(id, canvas);
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

  it('numbers migrations one by one, never lowering the oldest schema that may read them', () => {
    MIGRATIONS.forEach((migration, i) => {
      expect(migration.version).toBe(i + 1);
      expect(migration.minReader).toBeLessThanOrEqual(migration.version);
      expect(migration.minReader).toBeGreaterThanOrEqual(MIGRATIONS[i - 1]?.minReader ?? 1);
    });
    expect(SCHEMA).toBe(MIGRATIONS.length);
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
          `INSERT INTO message (id, canvas_id, from_party, to_party, kind, state, sent_at)
           VALUES ('m', ?, 'you', 'agent:a', 'text', 'pending', 1)`,
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
      `INSERT INTO worktree_job (id, workspace_id, kind, phase, generation, payload, outcome,
         created_at, updated_at)
       VALUES (?, ?, ?, 'intent', 1, '{}', ?, 1, 1)`,
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

    migrate(connection);

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
