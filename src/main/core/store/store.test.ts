import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore } from './open';
import { connect, resultCode, SQLITE_FULL } from './sqlite';
import type { Connection } from './sqlite';
import type { Store } from './store';

/*
 * The core's database, open (Core Database §4): one write lane, whose writes queued within one
 * turn of the loop share one transaction (group commit), each resolving only once the commit that
 * holds it has returned: what "on disk before it is sent" means now.
 */

let profile: string;
let store: Store;
/** A second connection, which only reads: what another process would see on disk. */
let reader: Connection;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-store-'));
  const opened = await openStore(profile);
  if (opened.store === undefined) throw new Error(opened.said.join(' '));
  store = opened.store;
  store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
  reader = connect(store.file, { readOnly: true });
});

afterEach(async () => {
  reader.close();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

const add = (text: string) => store.prepare('INSERT INTO note (text) VALUES (?)').run(text);
/** The notes on disk, as the reader sees them. */
const notes = () =>
  reader
    .prepare('SELECT text FROM note ORDER BY rowid')
    .all()
    .map((row) => row.text);
/** Settles every promise, as each came out. */
const outcomes = (promises: Promise<unknown>[]) => Promise.allSettled(promises);

describe('the write lane', () => {
  it('resolves a write with what it returned only once another connection can read it', async () => {
    let seen: unknown[] | undefined;
    const written = store
      .write(() => {
        add('one');
        return 'written';
      })
      .then((value) => {
        seen = notes();
        return value;
      });
    expect(notes()).toEqual([]);
    await expect(written).resolves.toBe('written');
    expect(seen).toEqual(['one']);
  });

  it('commits the writes queued in one turn of the loop together', async () => {
    let between: unknown[] | undefined;
    const first = store.write(() => add('first'));
    const second = store.write(() => {
      between = notes();
      add('second');
    });
    await Promise.all([first, second]);
    // The second ran before the first was committed: they shared the commit.
    expect(between).toEqual([]);
    expect(notes()).toEqual(['first', 'second']);
  });

  it('rolls back only a write that failed, rejecting only its caller', async () => {
    const failure = new Error('It went wrong');
    const settled = await outcomes([
      store.write(() => add('kept')),
      store.write(() => {
        add('lost');
        throw failure;
      }),
      store.write(() => add('kept too')),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(settled[1]).toEqual({ status: 'rejected', reason: failure });
    expect(notes()).toEqual(['kept', 'kept too']);
  });

  it('keeps nothing of a write whose statement a trigger aborted, and rejects it', async () => {
    store.exec(`CREATE TRIGGER refuse AFTER INSERT ON note WHEN NEW.text = 'refused'
      BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`);
    const settled = await outcomes([
      store.write(() => {
        add('before');
        add('refused');
      }),
      store.write(() => add('another')),
    ]);
    expect(settled[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'Refused by the test' },
    });
    expect(settled[1]?.status).toBe('fulfilled');
    expect(notes()).toEqual(['another']);
  });

  it('rejects every write of a batch whose commit fails, keeping none, and goes on', async () => {
    // A foreign key checked only as the transaction commits.
    store.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE child (parent INTEGER NOT NULL
        REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED) STRICT`);
    const settled = await outcomes([
      store.write(() => add('in the batch')),
      store.write(() => store.prepare('INSERT INTO child (parent) VALUES (1)').run()),
    ]);
    for (const outcome of settled) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { message: 'FOREIGN KEY constraint failed' },
      });
    }
    expect(notes()).toEqual([]);
    await store.write(() => add('after'));
    expect(notes()).toEqual(['after']);
  });

  it('rejects what a batch wrote before a full disk with the disk’s error, and goes on', async () => {
    const pages = store.prepare('PRAGMA page_count').get()?.page_count as number;
    store.exec(`PRAGMA max_page_count = ${String(pages + 2)}`);
    const settled = await outcomes([
      store.write(() => add('before')),
      store.write(() => {
        for (let i = 0; i < 100; i++) add('x'.repeat(2000));
      }),
      store.write(() => add('after')),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    for (const outcome of settled.slice(0, 2)) {
      expect(resultCode((outcome as PromiseRejectedResult).reason)).toBe(SQLITE_FULL);
    }
    expect(notes()).toEqual(['after']);
  });

  it('refuses a write that returns a promise, keeping nothing of it', async () => {
    await expect(
      store.write(() => {
        add('before the await');
        return Promise.resolve();
      }),
    ).rejects.toThrow('A transaction’s function must be synchronous');
    expect(notes()).toEqual([]);
  });

  it('commits the writes queued before it closes, and refuses those after', async () => {
    const queued = store.write(() => add('queued'));
    const closed = store.close();
    await expect(store.write(() => add('too late'))).rejects.toThrow(
      'The core’s database is closed.',
    );
    await expect(queued).resolves.toBeDefined();
    await closed;
    expect(notes()).toEqual(['queued']);
  });
});

describe('tx', () => {
  it('commits at once what its function did, and returns what it returned', () => {
    expect(store.tx(() => add('now').changes)).toBe(1);
    expect(notes()).toEqual(['now']);
  });
});
