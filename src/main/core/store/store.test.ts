import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openStore } from './open';
import { connect, resultCode, SQLITE_FULL } from './sqlite';
import type { Connection } from './sqlite';
import type { Store, StoreDeps } from './store';

/*
 * The core's database, open (Core Database §4): one write lane, whose writes queued within one
 * turn of the loop share one transaction (group commit), each resolving only once the commit that
 * holds it has returned: what "on disk before it is sent" means now. Its log is checkpointed when
 * it is idle, and truncated as it closes; snapshots of it are taken as it closes and every few
 * hours, the newest three kept.
 */

/** A timer the store set, and whether it ran or was cancelled since. */
interface Timer {
  run: () => void;
  ms: number;
  done: boolean;
}

let profile: string;
let store: Store;
/** A second connection, which only reads: what another process would see on disk. */
let reader: Connection;
/** The store's clock, and the timers it set, by the test's hand. */
let now: number;
let timers: Timer[];
const deps: StoreDeps = {
  later: (run, ms) => {
    const timer = { run, ms, done: false };
    timers.push(timer);
    return () => {
      timer.done = true;
    };
  },
  now: () => now,
};
/** The timers the store has set that neither ran nor were cancelled. */
const pending = () => timers.filter(({ done }) => !done);
/** Runs the one timer pending. */
function fire(): void {
  const [timer, ...others] = pending();
  if (timer === undefined || others.length > 0) throw new Error('Not one timer pending');
  timer.done = true;
  timer.run();
}

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-store-'));
  now = Date.UTC(2026, 9, 19, 12);
  timers = [];
  const opened = await openStore(profile, deps);
  if (opened.store === undefined) throw new Error(opened.said.join(' '));
  store = opened.store;
  store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
  reader = connect(store.file, { readOnly: true });
});

afterEach(async () => {
  if (reader.isOpen) reader.close();
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

  it('refuses a write that a write queues as it closes, and leaves nothing to run after', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let queued: Promise<unknown> | undefined;
    const outer = store.write(() => {
      add('outer');
      // A transaction within the lane's goes on as a savepoint of it.
      store.tx(() => add('nested'));
      queued = store.write(() => add('queued by it'));
    });
    const closed = store.close();
    await expect(outer).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow('The core’s database is closed.');
    await closed;
    expect(pending()).toEqual([]);
    expect(notes()).toEqual(['outer', 'nested']);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('tx', () => {
  it('commits at once what its function did, and returns what it returned', () => {
    expect(store.tx(() => add('now').changes)).toBe(1);
    expect(notes()).toEqual(['now']);
  });

  it('refuses once the store is closing, keeping nothing', async () => {
    const closed = store.close();
    expect(() => store.tx(() => add('too late'))).toThrow('The core’s database is closed.');
    await closed;
    expect(notes()).toEqual([]);
    expect(pending()).toEqual([]);
  });
});

describe('checkpoints', () => {
  it('checkpoints the log into the database once writes stop for a second', async () => {
    const size = async () => (await stat(store.file)).size;
    await store.write(() => {
      for (let i = 0; i < 200; i++) add(`note ${String(i)}`);
    });
    const before = await size();
    expect(pending()).toEqual([expect.objectContaining({ ms: 1000 })]);

    fire();

    expect(await size()).toBeGreaterThan(before);
    expect(pending()).toEqual([]);
  });

  it('waits for a pause after each commit, but never more than 30 seconds in all', async () => {
    await store.write(() => add('first'));
    for (let i = 0; i < 59; i++) {
      now += 500;
      store.tx(() => add('another'));
    }
    // 29.5 s after the first commit: its checkpoint is due in half a second, whatever comes.
    expect(pending().map(({ ms }) => ms)).toEqual([500]);
    now += 500;
    store.tx(() => add('one more'));
    expect(pending().map(({ ms }) => ms)).toEqual([0]);
    fire();
    store.tx(() => add('after the checkpoint'));
    expect(pending().map(({ ms }) => ms)).toEqual([1000]);
  });

  it('truncates its log as it closes, keeping everything in the database', async () => {
    await store.write(() => add('kept'));
    expect((await stat(`${store.file}-wal`)).size).toBeGreaterThan(0);
    reader.close();
    await store.close();
    await expect(stat(`${store.file}-wal`)).rejects.toThrow(/ENOENT/);
    expect(pending()).toEqual([]);
    const reopened = connect(store.file, { readOnly: true });
    try {
      expect(reopened.prepare('SELECT text FROM note').all()).toEqual([{ text: 'kept' }]);
    } finally {
      reopened.close();
    }
  });

  it('closes once, however often it is asked to', async () => {
    const closing = [store.close(), store.close()];
    expect(closing[0]).toBe(closing[1]);
    await Promise.all(closing);
    await expect(store.close()).resolves.toBeUndefined();
    expect(await readdir(path.join(profile, 'backups'))).toHaveLength(1);
  });
});

describe('snapshots', () => {
  const backups = () => path.join(profile, 'backups');
  const names = async () => (await readdir(backups())).sort();
  /** What a snapshot holds, read as it would be restored: on its own, checked. */
  function inSnapshot(name: string): { check: unknown; journal: unknown; notes: number } {
    const snapshot = connect(path.join(backups(), name), { readOnly: true });
    try {
      return {
        check: snapshot.prepare('PRAGMA quick_check').get()?.quick_check,
        journal: snapshot.prepare('PRAGMA journal_mode').get()?.journal_mode,
        notes: snapshot.prepare('SELECT count(*) AS notes FROM note').get()?.notes as number,
      };
    } finally {
      snapshot.close();
    }
  }

  it('takes one as it closes, into backups/, a file of its own that only the user may read', async () => {
    await store.write(() => add('kept'));
    reader.close();
    await store.close();
    expect(await names()).toEqual(['core-2026-10-19T12-00-00-000Z.db']);
    expect(inSnapshot('core-2026-10-19T12-00-00-000Z.db')).toEqual({
      check: 'ok',
      journal: 'delete',
      notes: 1,
    });
    if (process.platform !== 'win32') {
      expect((await stat(backups())).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(backups(), 'core-2026-10-19T12-00-00-000Z.db'))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it('takes one every four hours, once idle after writes, the first as soon as it is', async () => {
    const idleAfterWriting = async () => {
      await store.write(() => add('a note'));
      fire();
    };
    await idleAfterWriting();
    await vi.waitFor(async () => {
      expect(await names()).toEqual(['core-2026-10-19T12-00-00-000Z.db']);
    });
    now += 3 * 3600_000;
    await idleAfterWriting();
    now += 3600_000;
    await idleAfterWriting();
    await vi.waitFor(async () => {
      expect(await names()).toEqual([
        'core-2026-10-19T12-00-00-000Z.db',
        'core-2026-10-19T16-00-00-000Z.db',
      ]);
    });
  });

  it('keeps the newest three', async () => {
    for (let hour = 0; hour < 5; hour++) {
      now = Date.UTC(2026, 9, 19, hour);
      await store.snapshot();
    }
    expect(await names()).toEqual([
      'core-2026-10-19T02-00-00-000Z.db',
      'core-2026-10-19T03-00-00-000Z.db',
      'core-2026-10-19T04-00-00-000Z.db',
    ]);
  });

  it('keeps no snapshot of a database that looks damaged, nor forgets an older one for it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.write(() => {
      for (let i = 0; i < 300; i++) add('x'.repeat(200));
    });
    store.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await store.snapshot();
    // The disk damages pages of the open database (as a failing drive may), unnoticed by the core.
    const pages = (await stat(store.file)).size / 4096;
    const handle = await open(store.file, 'r+');
    for (const page of [pages - 6, pages - 4, pages - 2]) {
      await handle.write(Buffer.alloc(512, 0x5a), 0, 512, (page - 1) * 4096 + 100);
    }
    await handle.close();

    for (const hour of [16, 20, 24, 28]) {
      now = Date.UTC(2026, 9, 19, hour);
      await expect(store.snapshot()).rejects.toThrow(
        /^The core’s database looks damaged \(SQLite’s check of a snapshot of it found: .+\), so the snapshot was not kept\.$/,
      );
    }

    expect(await names()).toEqual(['core-2026-10-19T12-00-00-000Z.db']);
    await store.close();
    expect(await names()).toEqual(['core-2026-10-19T12-00-00-000Z.db']);
    expect(errors).toHaveBeenCalledWith(
      'Could not take a snapshot of the core’s database as it closed:',
      expect.objectContaining({ message: expect.stringMatching(/looks damaged/) }),
    );
  });

  it('removes what a snapshot cut short left behind', async () => {
    // What a core killed while taking a snapshot leaves: the partial copy, and its journal.
    await mkdir(backups(), { recursive: true });
    await writeFile(path.join(backups(), 'core-2026-10-18T09-00-00-000Z.db.partial'), 'cut short');
    await writeFile(path.join(backups(), 'core-2026-10-18T09-00-00-000Z.db.partial-journal'), '');
    await store.snapshot();
    expect(await names()).toEqual(['core-2026-10-19T12-00-00-000Z.db']);
  });

  it('takes a sound one while it goes on being written', async () => {
    await store.write(() => {
      for (let i = 0; i < 2000; i++) add('x'.repeat(1000));
    });
    let written = 0;
    let writtenBefore: number | undefined;
    const taken = store.snapshot().then((file) => {
      writtenBefore = written;
      return file;
    });
    while (writtenBefore === undefined) {
      await store.write(() => {
        add('during');
        store.prepare('DELETE FROM note WHERE rowid = (SELECT min(rowid) FROM note)').run();
      });
      written++;
    }
    const { check, notes } = inSnapshot(path.basename(await taken));
    expect(writtenBefore).toBeGreaterThan(0);
    expect(check).toBe('ok');
    expect(notes).toBe(2000);
  });
});
