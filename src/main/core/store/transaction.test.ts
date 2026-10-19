import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connect, resultCode, SQLITE_BUSY, SQLITE_FULL } from './sqlite';
import type { Connection } from './sqlite';
import { transaction } from './transaction';

/*
 * A transaction (Core Database §3): BEGIN IMMEDIATE, a synchronous function, COMMIT; on an error,
 * ROLLBACK only if SQLite hasn't already, and the error as it was; a SAVEPOINT within one.
 */

let folder: string;
let file: string;
let connection: Connection;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-transaction-'));
  file = path.join(folder, 'a.db');
  connection = connect(file, { timeout: 0 });
  connection.exec('PRAGMA journal_mode=WAL');
  connection.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
});

afterEach(async () => {
  connection.close();
  await rm(folder, { recursive: true, force: true });
});

const add = (text: string) => connection.prepare('INSERT INTO note (text) VALUES (?)').run(text);
const notes = () =>
  connection
    .prepare('SELECT text FROM note ORDER BY rowid')
    .all()
    .map((row) => row.text);

describe('transaction', () => {
  it('commits what its function did, and returns what it returned', () => {
    expect(
      transaction(connection, () => {
        add('one');
        add('two');
        return 2;
      }),
    ).toBe(2);
    expect(connection.isTransaction).toBe(false);
    expect(notes()).toEqual(['one', 'two']);
  });

  it('takes the database for writing as it begins', () => {
    const other = connect(file, { timeout: 0 });
    try {
      transaction(connection, () => {
        expect(
          resultCode(
            thrown(() => {
              other.exec('BEGIN IMMEDIATE');
            }),
          ),
        ).toBe(SQLITE_BUSY);
      });
    } finally {
      other.close();
    }
  });

  it('keeps nothing of a function that threw, and throws what it threw', () => {
    const failure = new Error('It went wrong');
    expect(() =>
      transaction(connection, () => {
        add('lost');
        throw failure;
      }),
    ).toThrow(failure);
    expect(connection.isTransaction).toBe(false);
    expect(notes()).toEqual([]);
  });

  it('keeps nothing of a function whose write a trigger refused', () => {
    connection.exec(`CREATE TRIGGER refuse AFTER INSERT ON note WHEN NEW.text = 'refused'
      BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`);
    expect(() => {
      transaction(connection, () => {
        add('before');
        add('refused');
      });
    }).toThrow('Refused by the test');
    expect(notes()).toEqual([]);
    add('after');
    expect(notes()).toEqual(['after']);
  });

  it('surfaces a full disk as it is, though SQLite rolled the transaction back already', () => {
    const pages = connection.prepare('PRAGMA page_count').get()?.page_count as number;
    connection.exec(`PRAGMA max_page_count = ${String(pages + 2)}`);
    const error = thrown(() => {
      transaction(connection, () => {
        for (let i = 0; i < 100; i++) add('x'.repeat(2000));
      });
    });
    expect(resultCode(error)).toBe(SQLITE_FULL);
    expect((error as Error).message).toMatch(/full/);
    expect(connection.isTransaction).toBe(false);
    expect(notes()).toEqual([]);
    add('room for one');
    expect(notes()).toEqual(['room for one']);
  });

  it('nests as a savepoint, rolling back only what failed within it', () => {
    transaction(connection, () => {
      add('outer');
      expect(() =>
        transaction(connection, () => {
          add('inner');
          throw new Error('The inner one failed');
        }),
      ).toThrow('The inner one failed');
      transaction(connection, () => {
        add('kept');
        transaction(connection, () => add('deepest'));
      });
    });
    expect(notes()).toEqual(['outer', 'kept', 'deepest']);
  });

  it('refuses a function that returns a promise, keeping nothing of it', async () => {
    let finished: Promise<void> | undefined;
    expect(() =>
      transaction(connection, () => {
        add('before the await');
        finished = Promise.resolve();
        return finished;
      }),
    ).toThrow('A transaction’s function must be synchronous: it would commit before it finished.');
    await finished;
    expect(notes()).toEqual([]);
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
