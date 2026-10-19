import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connect, extendedCode, resultCode, SQLITE_CORRUPT, SQLITE_NOTADB } from './sqlite';

/*
 * The one module that reaches Node's SQLite (Core Database §3), lazily: a static import of it would
 * be hoisted above the CLI's check of Node's version.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const SQLITE = path.join('src', 'main', 'core', 'store', 'sqlite.ts');
/** Loading Node's SQLite, or importing from it: by name, by require, or as a built-in. */
const LOADS =
  /from\s*['"]node:sqlite['"]|(?:require|import|getBuiltinModule)\s*\(\s*['"]node:sqlite['"]/;

/** Every TypeScript file of src, tests included, by its path from the root. */
function sources(dir = 'src'): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [file] : [];
  });
}

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-sqlite-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('node:sqlite', () => {
  it('is reached by this module alone', () => {
    const reaching = sources().filter((file) =>
      LOADS.test(readFileSync(path.join(ROOT, file), 'utf8')),
    );
    expect(reaching).toEqual([SQLITE]);
  });

  it('opens a connection to a file, and another that only reads it', () => {
    const file = path.join(folder, 'a.db');
    const writer = connect(file);
    const reader = connect(file, { readOnly: true });
    try {
      writer.exec('CREATE TABLE a (value TEXT NOT NULL) STRICT');
      writer.prepare('INSERT INTO a (value) VALUES (?)').run('written');
      expect(reader.prepare('SELECT value FROM a').get()).toEqual({ value: 'written' });
      expect(() => {
        reader.exec('DELETE FROM a');
      }).toThrow(/readonly/);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('reads the primary and extended result codes of SQLite’s errors, and none of others', async () => {
    const file = path.join(folder, 'text.db');
    await writeFile(file, 'This is not a database. '.repeat(100));
    const text = connect(file);
    const memory = connect(':memory:');
    try {
      expect(resultCode(thrown(() => text.prepare('SELECT 1').get()))).toBe(SQLITE_NOTADB);
      memory.exec('CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT; INSERT INTO a VALUES (1)');
      // An extended code (a primary key's, 1555) is read as its primary one, a constraint's (19).
      const insert = memory.prepare('INSERT INTO a VALUES (1)');
      expect(resultCode(thrown(() => insert.run()))).toBe(19);
      expect(extendedCode(thrown(() => insert.run()))).toBe(1555);
    } finally {
      text.close();
      memory.close();
    }
    expect(resultCode(new Error('not SQLite’s'))).toBeUndefined();
    expect(resultCode(undefined)).toBeUndefined();
    expect(extendedCode(new Error('not SQLite’s'))).toBeUndefined();
    expect(SQLITE_CORRUPT).toBe(11);
  });
});

/** What `run` threw. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('It threw nothing');
}
