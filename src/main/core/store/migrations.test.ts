import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate, MIGRATIONS, minReaderOf, SCHEMA, schemaOf } from './migrations';
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

describe('the schema', () => {
  it('migrates an empty database to the latest schema: singular tables, each STRICT', () => {
    migrate(connection);
    expect(schemaOf(connection)).toBe(SCHEMA);
    expect(minReaderOf(connection)).toBe(MIGRATIONS.at(-1)?.minReader);
    expect(tables()).toEqual([
      { name: 'canvas', strict: 1, wr: 0 },
      { name: 'conversation', strict: 1, wr: 1 },
      { name: 'message', strict: 1, wr: 0 },
      { name: 'meta', strict: 1, wr: 0 },
      { name: 'open_canvas', strict: 1, wr: 0 },
      { name: 'read_position', strict: 1, wr: 1 },
      { name: 'run', strict: 1, wr: 0 },
    ]);
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
        "INSERT INTO conversation (canvas_id, adapter, agent_id, native_id) VALUES (?, 'x', 'a', 'n')",
      )
      .run(CANVAS);
    connection
      .prepare("INSERT INTO run (canvas_id, state, workflow, updated_at) VALUES (?, '{}', '', 1)")
      .run(CANVAS);
    connection
      .prepare("INSERT INTO read_position (canvas_id, party, seq) VALUES (?, 'you', 1)")
      .run(CANVAS);
    connection.prepare('INSERT INTO open_canvas (canvas_id, opened_at) VALUES (?, 1)').run(CANVAS);
    connection.prepare('DELETE FROM canvas WHERE id = ?').run(CANVAS);
    for (const table of ['conversation', 'run', 'message', 'read_position', 'open_canvas']) {
      expect(connection.prepare(`SELECT count(*) AS rows FROM ${table}`).get(), table).toEqual({
        rows: 0,
      });
    }
    expect(connection.prepare('SELECT count(*) AS rows FROM canvas').get()).toEqual({ rows: 1 });
  });
});
