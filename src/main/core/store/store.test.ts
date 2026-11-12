import { fstatSync } from 'node:fs';
import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Checkpointer, JOURNAL_SIZE_LIMIT } from './checkpointer';
import type { Checkpointed } from './checkpointer';
import { openStore } from './open';
import { connect, resultCode, SQLITE_FULL } from './sqlite';
import type { Connection } from './sqlite';
import { SYSTEM_DEPS, unopened } from './store';
import type { Store, StoreDeps } from './store';

/*
 * The core's database, open (Core Database §4): one write lane, whose writes queued within one
 * turn of the loop share one transaction (group commit), each resolving only once the commit that
 * holds it has returned and its log has been flushed to the drive, off the loop: what "on disk
 * before it is sent" means now. Its log is checkpointed when it is idle, and truncated as it
 * closes; snapshots of it are taken as it closes and every few hours, the newest three kept.
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
/** The flushes of its log the store asked for while the test holds them (else they run at once). */
let flushes: { fd: number; done: (error?: Error) => void }[] | undefined;
const diskFault = vi.hoisted(() => ({
  truncate: false,
  sync: false,
  snapshotFolder: '',
  publication: undefined as
    { folder: string; started: () => void; wait: Promise<void> } | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      if (diskFault.sync) throw new Error('EIO: i/o error, fsync');
      fs.fsyncSync(...args);
    },
    ftruncateSync: (...args: Parameters<typeof fs.ftruncateSync>) => {
      if (diskFault.truncate) throw new Error('EIO: i/o error, ftruncate');
      fs.ftruncateSync(...args);
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === diskFault.snapshotFolder) {
        handle.sync = () => Promise.reject(new Error('EIO: i/o error, fsync folder'));
      }
      const publication = diskFault.publication;
      if (String(args[0]) === publication?.folder) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          publication.started();
          await publication.wait;
          await sync();
        };
      }
      return handle;
    },
  };
});
const deps: StoreDeps = {
  later: (run, ms) => {
    const timer = { run, ms, done: false };
    timers.push(timer);
    return () => {
      timer.done = true;
    };
  },
  now: () => now,
  flush: (fd) => {
    const held = flushes;
    if (held === undefined) return SYSTEM_DEPS.flush(fd);
    return new Promise((resolve, reject) => {
      held.push({
        fd,
        done: (error) => {
          if (error) reject(error);
          else resolve();
        },
      });
    });
  },
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
  flushes = undefined;
  const opened = await openStore(profile, deps);
  if (opened.store === undefined) throw new Error(opened.said.join(' '));
  store = opened.store;
  store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
  reader = connect(store.file, { readOnly: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  diskFault.truncate = false;
  diskFault.sync = false;
  diskFault.snapshotFolder = '';
  diskFault.publication = undefined;
  if (reader.isOpen) reader.close();
  for (const { done } of flushes?.splice(0) ?? []) done();
  flushes = undefined;
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
  it('creates only SQLite’s database, log and index on successful writes', async () => {
    const files = ['core.db', 'core.db-shm', 'core.db-wal'];
    expect((await readdir(profile)).sort()).toEqual(files);
    await store.writeBlocking(() => add('one'));
    store.tx(() => add('two'));
    await store.checkpoint();
    expect((await readdir(profile)).sort()).toEqual(files);
    expect(notes()).toEqual(['one', 'two']);
  });

  it('resolves a write with what it returned only once another connection can read it', async () => {
    let seen: unknown[] | undefined;
    const written = store
      .writeBlocking(() => {
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

  it('resolves a write only once its log is flushed to the drive, off the loop, after its commit', async () => {
    flushes = [];
    let resolved = false;
    const written = store
      .writeBlocking(() => add('one'))
      .then(() => {
        resolved = true;
      });
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    // Committed (another connection reads it), but not yet on the drive: not yet resolved.
    expect(notes()).toEqual(['one']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    // The log's own file.
    const [flush] = flushes;
    expect(fstatSync(flush?.fd ?? -1).ino).toBe((await stat(`${store.file}-wal`)).ino);
    flush?.done();
    await written;
    expect(resolved).toBe(true);
  });

  it.each([0, 1, 4])(
    'bounds a queued burst of writes changing %i rows, preserving their row and acknowledgement order',
    async (rows) => {
      flushes = [];
      const settled: number[] = [];
      const ran: number[] = [];
      const entries = (i: number) =>
        Array.from({ length: rows }, (_, j) => `${String(i)}.${String(j)}`);
      const writes = Array.from({ length: 40 }, (_, i) =>
        store
          .writeBlocking(() => {
            ran.push(i);
            for (const text of entries(i)) add(text);
          })
          .then(() => settled.push(i)),
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const first = Array.from({ length: rows === 4 ? 8 : 16 }, (_, i) => i);
        expect(ran).toEqual(first);
        expect(notes()).toEqual(first.flatMap(entries));
        expect(settled).toEqual([]);
      } finally {
        const held = flushes;
        flushes = undefined;
        held[0]?.done();
        await Promise.all(writes);
      }
      expect(ran).toEqual(Array.from({ length: 40 }, (_, i) => i));
      expect(notes()).toEqual(ran.flatMap(entries));
      expect(settled).toEqual(Array.from({ length: 40 }, (_, i) => i));
    },
  );

  it('keeps a large atomic write intact and leaves the next write for its next commit', async () => {
    flushes = [];
    const first = store.writeBlocking(() => {
      for (let i = 0; i < 40; i++) add(String(i));
    });
    const second = store.writeBlocking(() => add('next'));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(notes()).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
    } finally {
      const held = flushes;
      flushes = undefined;
      held[0]?.done();
      await Promise.all([first, second]);
    }
    expect(notes().at(-1)).toBe('next');
  });

  it('rolls back a failed bounded commit and still runs the writes after it in order', async () => {
    store.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE child (parent INTEGER NOT NULL
        REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED) STRICT`);
    const settled = await outcomes([
      store.writeBlocking(() => {
        for (let i = 0; i < 40; i++) add('rolled back');
        store.prepare('INSERT INTO child (parent) VALUES (1)').run();
      }),
      store.writeBlocking(() => add('second')),
      store.writeBlocking(() => add('third')),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(settled[0]).toMatchObject({ reason: { message: 'FOREIGN KEY constraint failed' } });
    expect(notes()).toEqual(['second', 'third']);
  });

  it('keeps later SQL off the loop while the log flush is running, in write order', async () => {
    flushes = [];
    const order: string[] = [];
    const first = store.writeBlocking(() => add('first')).then(() => order.push('first durable'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    const later = ['second', 'third'].map((text) =>
      store.writeBlocking(() => {
        order.push(text);
        add(text);
      }),
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(notes()).toEqual(['first']);
      expect(order).toEqual([]);
    } finally {
      const held = flushes;
      flushes = undefined;
      held[0]?.done();
      await first;
      await Promise.all(later);
    }
    expect(order).toEqual(['first durable', 'second', 'third']);
    expect(notes()).toEqual(['first', 'second', 'third']);
  });

  it('flushes its log one flush at a time, queued writes resolving only with their own flush', async () => {
    flushes = [];
    const first = store.writeBlocking(() => add('first'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    const settled: string[] = [];
    const later = ['second', 'third'].map((text) =>
      new Promise((resolve) => setImmediate(resolve))
        .then(() => store.writeBlocking(() => add(text)))
        .then(() => settled.push(text)),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notes()).toEqual(['first']);
    // Queued while the first flush went on, they commit and wait for their own flush after it.
    expect(flushes).toHaveLength(1);
    flushes[0]?.done();
    await first;
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(2);
    });
    expect(notes()).toEqual(['first', 'second', 'third']);
    expect(settled).toEqual([]);
    flushes[1]?.done();
    await Promise.all(later);
    expect(settled.toSorted()).toEqual(['second', 'third']);
  });

  it('closes once the flush going on has ended', async () => {
    flushes = [];
    const written = store.writeBlocking(() => add('one'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    flushes[0]?.done();
    await written;
    await closing;
    expect(closed).toBe(true);
  });

  it('commits the writes queued in one turn of the loop together', async () => {
    let between: unknown[] | undefined;
    const first = store.writeBlocking(() => add('first'));
    const second = store.writeBlocking(() => {
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
      store.writeBlocking(() => add('kept')),
      store.writeBlocking(() => {
        add('lost');
        throw failure;
      }),
      store.writeBlocking(() => add('kept too')),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(settled[1]).toEqual({ status: 'rejected', reason: failure });
    expect(notes()).toEqual(['kept', 'kept too']);
  });

  it('restores staged state before the next write runs after a failed savepoint', async () => {
    let staged = false;
    const settled = await outcomes([
      store.writeBlocking(
        () => {
          staged = true;
          throw new Error('The write failed');
        },
        () => {
          staged = false;
        },
      ),
      store.writeBlocking(() => {
        expect(staged).toBe(false);
        add('next');
      }),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['rejected', 'fulfilled']);
    expect(notes()).toEqual(['next']);
  });

  it('keeps nothing of a write whose statement a trigger aborted, and rejects it', async () => {
    store.exec(`CREATE TRIGGER refuse AFTER INSERT ON note WHEN NEW.text = 'refused'
      BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`);
    const settled = await outcomes([
      store.writeBlocking(() => {
        add('before');
        add('refused');
      }),
      store.writeBlocking(() => add('another')),
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
      store.writeBlocking(() => add('in the batch')),
      store.writeBlocking(() => store.prepare('INSERT INTO child (parent) VALUES (1)').run()),
    ]);
    for (const outcome of settled) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { message: 'FOREIGN KEY constraint failed' },
      });
    }
    expect(notes()).toEqual([]);
    await store.writeBlocking(() => add('after'));
    expect(notes()).toEqual(['after']);
  });

  it('rejects what a batch wrote before a full disk with the disk’s error, and goes on', async () => {
    const pages = store.prepare('PRAGMA page_count').get()?.page_count as number;
    store.exec(`PRAGMA max_page_count = ${String(pages + 2)}`);
    const settled = await outcomes([
      store.writeBlocking(() => add('before')),
      store.writeBlocking(() => {
        for (let i = 0; i < 100; i++) add('x'.repeat(2000));
      }),
      store.writeBlocking(() => add('after')),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    for (const outcome of settled.slice(0, 2)) {
      expect(resultCode((outcome as PromiseRejectedResult).reason)).toBe(SQLITE_FULL);
    }
    expect(notes()).toEqual(['after']);
  });

  it('refuses a write that returns a promise, keeping nothing of it', async () => {
    await expect(
      store.writeBlocking(() => {
        add('before the await');
        return Promise.resolve();
      }),
    ).rejects.toThrow('A transaction’s function must be synchronous');
    expect(notes()).toEqual([]);
  });

  it('commits the writes queued before it closes, and refuses those after', async () => {
    const wanted = Array.from({ length: 40 }, (_, i) => `queued ${String(i)}`);
    const queued = Promise.all(wanted.map((text) => store.writeBlocking(() => add(text))));
    const closed = store.close();
    await expect(store.writeBlocking(() => add('too late'))).rejects.toThrow(
      'The core’s database is closed.',
    );
    await expect(queued).resolves.toBeDefined();
    await closed;
    expect(notes()).toEqual(wanted);
  });

  it('refuses a write that a write queues as it closes, and leaves nothing to run after', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let queued: Promise<unknown> | undefined;
    const outer = store.writeBlocking(() => {
      add('outer');
      // A transaction within the lane's goes on as a savepoint of it.
      store.tx(() => add('nested'));
      queued = store.writeBlocking(() => add('queued by it'));
      void queued.catch(() => undefined);
    });
    const closed = store.close();
    // Refused at once, as it closed; the write that queued it, once its log is flushed.
    await expect(outer).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow('The core’s database is closed.');
    await closed;
    expect(pending()).toEqual([]);
    expect(notes()).toEqual(['outer', 'nested']);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('a failed flush', () => {
  const FAILED =
    /^The core’s database could not be written to the drive \(EIO: i\/o error, fsync\)/;
  /** The notes as a reopened store reads them: what was kept on the drive. */
  async function reopened(): Promise<unknown[]> {
    await store.close();
    // No other connection keeps the database's index (as none does in the core's process).
    if (reader.isOpen) reader.close();
    flushes = undefined;
    const opened = await openStore(profile, deps);
    if (opened.store === undefined) throw new Error(opened.said.join(' '));
    store = opened.store;
    reader = connect(store.file, { readOnly: true });
    return notes();
  }
  /** Holds the flushes from now on, and fails the first held, once the store asked for it. */
  async function failFlush(): Promise<void> {
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    flushes?.[0]?.done(new Error('EIO: i/o error, fsync'));
  }

  it('says on stderr that an unflushed write may come back after a restart if the cut fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.writeBlocking(() => add('kept'));
    flushes = [];
    const lost = store.writeBlocking(() => add('lost'));
    diskFault.truncate = true;
    await failFlush();
    await expect(lost).rejects.toThrow(FAILED);
    await store.close();
    expect(errors.mock.calls).toContainEqual([
      expect.stringMatching(/could not take back.*may come back after a restart/i),
      expect.objectContaining({ message: 'EIO: i/o error, ftruncate' }),
    ]);
    expect(() => store.prepare('SELECT text FROM note')).toThrow(FAILED);
    await expect(store.writeBlocking(() => add('after'))).rejects.toThrow(FAILED);
    expect((await readdir(profile)).sort()).toEqual(['core.db', 'core.db-shm', 'core.db-wal']);
  });

  it('removes a snapshot whose publication failed after rename before discarding an unflushed write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.writeBlocking(() => add('kept'));
    flushes = [];
    const lost = store.writeBlocking(() => add('lost'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    diskFault.snapshotFolder = path.join(profile, 'backups');
    await expect(store.snapshot()).rejects.toThrow('EIO');
    diskFault.snapshotFolder = '';
    await failFlush();
    await expect(lost).rejects.toThrow(FAILED);
    await store.close();
    expect(await readdir(path.join(profile, 'backups'))).toEqual([]);
    expect(await reopened()).toEqual(['kept']);
  });

  it('keeps none of its writes, nor any committed after them, and fails closed, saying so once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.writeBlocking(() => add('kept'));
    flushes = [];
    const lost = store.writeBlocking(() => add('lost'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    // Queued while that flush went on: it must fail too, without ever writing.
    const meanwhile = store.writeBlocking(() => add('meanwhile'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notes()).toEqual(['kept', 'lost']);
    await failFlush();
    await expect(lost).rejects.toThrow(FAILED);
    await expect(meanwhile).rejects.toThrow(FAILED);
    // Every write after it refused for the same reason, until it is opened again; and nothing
    // read back, as though it had been kept.
    await expect(store.writeBlocking(() => add('after'))).rejects.toThrow(FAILED);
    expect(() => store.tx(() => add('after'))).toThrow(FAILED);
    expect(() => store.prepare('SELECT text FROM note')).toThrow(FAILED);
    await expect(store.checkpoint()).rejects.toThrow(FAILED);
    expect(errors.mock.calls).toEqual([[expect.stringMatching(FAILED)]]);

    expect(await reopened()).toEqual(['kept']);
    await store.writeBlocking(() => add('again'));
    expect(notes()).toEqual(['kept', 'again']);
  });

  it('keeps none of them after it began its log anew', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.writeBlocking(() => {
      for (let i = 0; i < 300; i++) add('x'.repeat(2000));
    });
    // Copied into the database, and begun anew: what it wrote before is still in the log's file.
    await store.checkpoint();
    await store.writeBlocking(() => add('kept'));
    flushes = [];
    const lost = store.writeBlocking(() => add('lost'));
    await failFlush();
    await expect(lost).rejects.toThrow(FAILED);
    const kept = await reopened();
    expect(kept).toHaveLength(301);
    expect(kept.at(-1)).toBe('kept');
    expect(reader.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
  });

  it('checkpoints nothing whose flush hasn’t ended, nor what a failed one was for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await store.writeBlocking(() => add('kept'));
    flushes = [];
    const lost = store.writeBlocking(() => add('lost'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    let settled = false;
    const checkpointed = store.checkpoint().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await failFlush();
    await expect(checkpointed).rejects.toThrow(FAILED);
    await expect(lost).rejects.toThrow(FAILED);
    expect(await reopened()).toEqual(['kept']);
  });

  it('closes without a checkpoint or snapshot, and keeps no snapshot that may hold what it lost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backups = () => readdir(path.join(profile, 'backups'));
    await store.writeBlocking(() => add('kept'));
    await store.snapshot();
    flushes = [];
    const lost = store.writeBlocking(() => add('lost'));
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    // Taken while its flush went on: it holds what that flush was for.
    now += 3600_000;
    await store.snapshot();
    expect(await backups()).toHaveLength(2);
    await failFlush();
    await expect(lost).rejects.toThrow(FAILED);
    now += 3600_000;
    await store.close();
    expect(await backups()).toEqual(['core-2026-10-19T12-00-00-000Z.db']);
    expect(pending()).toEqual([]);
    expect(await reopened()).toEqual(['kept']);
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
  it('leaves writes free while a snapshot occupies the worker, postponing idle maintenance', async () => {
    const release = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    const original: (this: Checkpointer, partial: string) => Promise<void> = Reflect.get(
      Checkpointer.prototype,
      'snapshot',
    );
    vi.spyOn(Checkpointer.prototype, 'snapshot').mockImplementation(async function (
      this: Checkpointer,
      partial,
    ) {
      entered.resolve(undefined);
      await release.promise;
      await original.call(this, partial);
    });
    const checkpoint: (this: Checkpointer) => Promise<Checkpointed> = Reflect.get(
      Checkpointer.prototype,
      'checkpoint',
    );
    // A job posted to the busy worker cannot answer until the scan gives its thread back.
    const checkpoints = vi
      .spyOn(Checkpointer.prototype, 'checkpoint')
      .mockImplementation(async function (this: Checkpointer) {
        await release.promise;
        return checkpoint.call(this);
      });
    await store.writeBlocking(() => add('before'));
    const snapshot = store.snapshot();
    await entered.promise;
    fire();
    let committed = false;
    const written = store.writeBlocking(() => {
      add('while busy');
      committed = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(committed).toBe(true);
      expect(checkpoints).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      await Promise.all([snapshot, written]);
    }
  });
  it('checkpoints the log into the database once writes stop for a second', async () => {
    const size = async () => (await stat(store.file)).size;
    await store.writeBlocking(() => {
      for (let i = 0; i < 200; i++) add(`note ${String(i)}`);
    });
    const before = await size();
    expect(pending()).toEqual([expect.objectContaining({ ms: 1000 })]);

    fire();

    await vi.waitFor(async () => {
      expect(await size()).toBeGreaterThan(before);
    });
    expect(pending()).toEqual([]);
  });

  it('checkpoints on a thread of its own, the lane committing what came meanwhile once it is done', async () => {
    const size = async () => (await stat(store.file)).size;
    await store.writeBlocking(() => {
      for (let i = 0; i < 200; i++) add(`note ${String(i)}`);
    });
    const before = await size();
    const order: string[] = [];
    const checkpointed = store.checkpoint().then(() => order.push('checkpointed'));
    // The store reads meanwhile, as the core goes on.
    expect(store.prepare('SELECT count(*) AS notes FROM note').get()).toEqual({ notes: 200 });
    const written = store.writeBlocking(() => {
      order.push('committed');
      add('meanwhile');
    });
    await Promise.all([checkpointed, written]);
    expect(order).toEqual(['checkpointed', 'committed']);
    expect(await size()).toBeGreaterThan(before);
    expect(notes()).toHaveLength(201);
  });

  it('begins its log anew on its checkpointer’s thread, never as it commits', async () => {
    // The log's header: its checkpoint's number and its salts, which beginning it anew changes.
    const header = async () =>
      (await readFile(`${store.file}-wal`)).subarray(12, 24).toString('hex');
    await store.writeBlocking(() => add('one'));
    const before = await header();
    await store.checkpoint();
    const begun = await header();
    expect(begun).not.toBe(before);
    await store.writeBlocking(() => add('two'));
    expect(await header()).toBe(begun);
    expect(notes()).toEqual(['one', 'two']);
  });

  it('cuts its log back to its size limit as it begins it anew', async () => {
    const log = async () => (await stat(`${store.file}-wal`)).size;
    await store.writeBlocking(() => {
      for (let i = 0; i < 3000; i++) add('x'.repeat(2000));
    });
    expect(await log()).toBeGreaterThan(JOURNAL_SIZE_LIMIT);
    await store.checkpoint();
    expect(await log()).toBeLessThanOrEqual(JOURNAL_SIZE_LIMIT);
    expect(notes()).toHaveLength(3000);
  });

  it('waits for a pause after each commit, but never more than 30 seconds in all', async () => {
    await store.writeBlocking(() => add('first'));
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
    // The write lane waits for the worker rather than racing a synchronous transaction with it.
    await store.writeBlocking(() => add('after the checkpoint'));
    expect(pending().map(({ ms }) => ms)).toEqual([1000]);
  });

  it('truncates its log as it closes, keeping everything in the database', async () => {
    await store.writeBlocking(() => add('kept'));
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

  it('never returns a published snapshot after failing closed during its directory sync', async () => {
    flushes = [];
    const written = store.writeBlocking(() => add('unflushed'));
    const rejected = written.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(flushes).toHaveLength(1);
    });
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    diskFault.publication = {
      folder: backups(),
      started: () => {
        entered.resolve(undefined);
      },
      wait: release.promise,
    };
    const taking = store.snapshot();
    await entered.promise;
    flushes[0]?.done(new Error('EIO'));
    // Let the failed flush fail closed before the publication's last fsync returns.
    await new Promise((resolve) => setImmediate(resolve));
    release.resolve(undefined);
    await expect(taking).rejects.toThrow(/could not be written/);
    expect(await rejected).toBeInstanceOf(Error);
    expect(await names()).toEqual([]);
  });
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
    await store.writeBlocking(() => add('kept'));
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
      await store.writeBlocking(() => add('a note'));
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
    await store.writeBlocking(() => {
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
      expect.objectContaining({ message: expect.stringMatching(/looks damaged/) as unknown }),
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
    await store.writeBlocking(() => {
      for (let i = 0; i < 2000; i++) add('x'.repeat(1000));
    });
    let written = 0;
    let writtenBefore: number | undefined;
    const taken = store.snapshot().then((file) => {
      writtenBefore = written;
      return file;
    });
    while (writtenBefore === undefined) {
      await store.writeBlocking(() => {
        add('during');
        store.prepare('DELETE FROM note WHERE rowid = (SELECT min(rowid) FROM note)').run();
      });
      written++;
    }
    const { check, notes } = inSnapshot(path.basename(await taken));
    // A concurrent write progresses; its fsync need not finish before the backup's publication.
    expect(written).toBeGreaterThan(0);
    expect(check).toBe('ok');
    expect(notes).toBe(2000);
  });
});

describe('planned writes', () => {
  const INSERT = 'INSERT INTO note (text) VALUES (?)';
  /** A planned write that notes `text`. */
  const plan = (text: string) =>
    store.write(() => {
      store.run(INSERT, text);
    });
  /** What the tests' writes and hooks did, in order. */
  let log: string[];
  beforeEach(() => {
    log = [];
    store.exec(`CREATE TRIGGER refuse AFTER INSERT ON note WHEN NEW.text = 'refused'
      BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`);
  });
  /** A planned write that fails (`how`), after staging, with hooks `name` leaves in `log`. */
  function staged(name: string, how: 'statement' | 'plan' | 'none' = 'none'): Promise<void> {
    return store.write(
      () => {
        log.push(`plan ${name}`);
        store.undo(() => log.push(`undo ${name} 1`));
        store.undo(() => log.push(`undo ${name} 2`));
        store.run(INSERT, how === 'statement' ? 'refused' : name);
        if (how === 'plan') throw new Error(`${name} failed`);
      },
      () => log.push(`failed ${name}`),
    );
  }

  it('runs its statements in order, in a savepoint of its own, after its plan', async () => {
    let planned = false;
    const written = store.write(() => {
      store.run(INSERT, 'one');
      store.run(INSERT, 'two');
      planned = true;
      return 'planned';
    });
    expect(planned).toBe(false);
    await expect(written).resolves.toBe('planned');
    expect(notes()).toEqual(['one', 'two']);
  });

  it('rolls back only the write whose statement failed, rejecting only its caller', async () => {
    const settled = await outcomes([
      plan('before'),
      store.write(() => {
        store.run(INSERT, 'lost');
        store.run(INSERT, 'refused');
      }),
      plan('after'),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(settled[1]).toMatchObject({ reason: { message: 'Refused by the test' } });
    expect(notes()).toEqual(['before', 'after']);
  });

  it('refuses to read, keeping nothing of the write', async () => {
    const settled = await outcomes([
      store.write(() => {
        store.run(INSERT, 'lost');
        store.prepare('SELECT count(*) FROM note').get();
      }),
      plan('kept'),
    ]);
    expect(settled[0]).toMatchObject({
      status: 'rejected',
      reason: { message: expect.stringMatching(/planned write.*read/i) as string },
    });
    expect(settled[1]?.status).toBe('fulfilled');
    expect(notes()).toEqual(['kept']);
  });

  it('refuses a statement or a hook outside a write', () => {
    for (const outside of [
      () => {
        store.run(INSERT, 'x');
      },
      () => {
        store.runExpecting(INSERT, ['x'], 1, 'No');
      },
      () => {
        store.runReturning(INSERT, ['x'], () => undefined);
      },
      () => {
        store.undo(() => undefined);
      },
      () => {
        store.followUp(() => undefined);
      },
    ]) {
      expect(outside).toThrow(/within a write/i);
    }
    expect(notes()).toEqual([]);
  });

  describe('restores in-memory staging', () => {
    it('after a failed statement: its hooks newest first, then failed, before the next plan', async () => {
      const settled = await outcomes([staged('a', 'statement'), staged('b')]);
      expect(settled.map(({ status }) => status)).toEqual(['rejected', 'fulfilled']);
      expect(log).toEqual(['plan a', 'undo a 2', 'undo a 1', 'failed a', 'plan b']);
      expect(notes()).toEqual(['b']);
    });

    it('after a plan that threw, which sent no statement', async () => {
      const settled = await outcomes([staged('a', 'plan'), staged('b')]);
      expect(settled.map(({ status }) => status)).toEqual(['rejected', 'fulfilled']);
      expect(log).toEqual(['plan a', 'undo a 2', 'undo a 1', 'failed a', 'plan b']);
      expect(notes()).toEqual(['b']);
    });

    it('after a failed commit: the newest write’s first', async () => {
      store.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE child (parent INTEGER NOT NULL
          REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED) STRICT`);
      const settled = await outcomes([
        staged('a'),
        staged('b'),
        store.write(
          () => {
            log.push('plan c');
            store.undo(() => log.push('undo c'));
            store.run('INSERT INTO child (parent) VALUES (1)');
          },
          () => log.push('failed c'),
        ),
      ]);
      expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'rejected']);
      expect(log).toEqual([
        'plan a',
        'plan b',
        'plan c',
        'undo c',
        'failed c',
        'undo b 2',
        'undo b 1',
        'failed b',
        'undo a 2',
        'undo a 1',
        'failed a',
      ]);
      expect(notes()).toEqual([]);
    });

    it('after a failed flush: the newest write’s first', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      flushes = [];
      const settled = outcomes([staged('a'), staged('b')]);
      await vi.waitFor(() => {
        expect(flushes).toHaveLength(1);
      });
      flushes[0]?.done(new Error('EIO: i/o error, fsync'));
      expect((await settled).map(({ status }) => status)).toEqual(['rejected', 'rejected']);
      expect(log).toEqual([
        'plan a',
        'plan b',
        'undo b 2',
        'undo b 1',
        'failed b',
        'undo a 2',
        'undo a 1',
        'failed a',
      ]);
    });

    it('never for a write that stayed', async () => {
      await staged('a');
      expect(log).toEqual(['plan a']);
    });
  });

  it('gives runReturning’s rows to its callback before the next write is planned and before it resolves', async () => {
    const first = store
      .write(() => {
        store.runReturning(`${INSERT} RETURNING text`, ['first'], (rows) => {
          log.push(`rows ${JSON.stringify(rows)}`);
        });
        log.push('plan first');
      })
      .then(() => log.push('resolved first'));
    const second = store.write(() => log.push('plan second'));
    await Promise.all([first, second]);
    expect(log).toEqual(['plan first', 'rows [{"text":"first"}]', 'plan second', 'resolved first']);
  });

  it('fails only its write when runExpecting changed other than the rows it expected', async () => {
    const settled = await outcomes([
      plan('kept'),
      store.write(() => {
        store.run(INSERT, 'lost');
        store.runExpecting('UPDATE note SET text = ? WHERE text = ?', ['x', 'absent'], 1, 'Gone');
      }),
      plan('also kept'),
    ]);
    expect(settled.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(settled[1]).toMatchObject({ reason: { message: 'Gone' } });
    expect(notes()).toEqual(['kept', 'also kept']);
  });

  it('keeps the rows runExpecting expected', async () => {
    await plan('one');
    await store.write(() => {
      store.runExpecting('UPDATE note SET text = ? WHERE text = ?', ['two', 'one'], 1, 'Gone');
    });
    expect(notes()).toEqual(['two']);
  });

  describe('a follow-up', () => {
    it('runs right after its write, in the same commit, as a blocking write', async () => {
      flushes = [];
      const first = store.write(() => {
        store.run(INSERT, 'first');
        store.followUp(() => {
          // Blocking: it reads what its write, and it, wrote.
          store.run(INSERT, 'follow');
          log.push(JSON.stringify(store.prepare('SELECT text FROM note ORDER BY rowid').all()));
        });
      });
      const second = plan('second');
      await vi.waitFor(() => {
        expect(flushes).toHaveLength(1);
      });
      expect(notes()).toEqual(['first', 'follow', 'second']);
      expect(log).toEqual(['[{"text":"first"},{"text":"follow"}]']);
      flushes[0]?.done();
      await Promise.all([first, second]);
      expect(flushes).toHaveLength(1);
    });

    it('runs even when its write is the last the bound of 16 writes allows', async () => {
      flushes = [];
      const writes = Array.from({ length: 16 }, (_, i) =>
        store.write(() => {
          store.run(INSERT, `write ${String(i)}`);
          if (i === 15)
            store.followUp(() => {
              store.run(INSERT, 'follow');
            });
        }),
      );
      const seventeenth = plan('seventeenth');
      await vi.waitFor(() => {
        expect(flushes).toHaveLength(1);
      });
      expect(notes()).toHaveLength(17);
      expect(notes().at(-1)).toBe('follow');
      flushes[0]?.done();
      await vi.waitFor(() => {
        expect(flushes).toHaveLength(2);
      });
      flushes[1]?.done();
      await Promise.all([...writes, seventeenth]);
      expect(notes().at(-1)).toBe('seventeenth');
    });
  });

  describe('within a blocking write, or a tx', () => {
    it('restores a synchronous transaction’s memory if its log flush fails', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let staged = 'before';
      diskFault.sync = true;
      expect(() => {
        store.tx(() => {
          store.undo(() => {
            staged = 'before';
          });
          staged = 'inside';
          store.run(INSERT, 'inside');
        });
      }).toThrow(/could not be written to the drive/);
      expect(staged).toBe('before');
      diskFault.sync = false;
    });

    it('restores a failed nested transaction before its caller continues', async () => {
      let staged = 'before';
      await store.writeBlocking(() => {
        expect(() =>
          store.tx(() => {
            store.undo(() => {
              staged = 'before';
            });
            staged = 'inside';
            store.run(INSERT, 'inside');
            throw new Error('The nested transaction was refused');
          }),
        ).toThrow('The nested transaction was refused');
        expect(staged).toBe('before');
        store.run(INSERT, 'after');
      });
      expect(notes()).toEqual(['after']);
      expect(staged).toBe('before');
    });

    it('restores a successful nested transaction in order when its parent fails', async () => {
      let staged = 0;
      await expect(
        store.writeBlocking(() => {
          store.undo(() => {
            staged = 0;
          });
          staged = 1;
          store.tx(() => {
            store.undo(() => {
              staged = 1;
            });
            staged = 2;
            store.run(INSERT, 'inside');
          });
          store.undo(() => {
            staged = 2;
          });
          staged = 3;
          throw new Error('The containing write was refused');
        }),
      ).rejects.toThrow('The containing write was refused');
      expect(staged).toBe(0);
      expect(notes()).toEqual([]);
    });

    it('runs a planned write’s statements at once, and gives rows at once', async () => {
      await store.writeBlocking(() => {
        store.run(INSERT, 'now');
        expect(store.prepare('SELECT count(*) AS count FROM note').get()?.count).toBe(1);
        store.runReturning(`${INSERT} RETURNING text`, ['returned'], (rows) => {
          log.push(JSON.stringify(rows));
        });
        expect(log).toEqual(['[{"text":"returned"}]']);
        expect(() => {
          store.runExpecting('UPDATE note SET text = ? WHERE text = ?', ['x', 'absent'], 1, 'Gone');
        }).toThrow('Gone');
      });
      expect(notes()).toEqual(['now', 'returned']);
    });

    it('does the same in a tx', () => {
      store.tx(() => {
        store.run(INSERT, 'now');
        store.runReturning(`${INSERT} RETURNING text`, ['returned'], (rows) => {
          log.push(JSON.stringify(rows));
        });
      });
      expect(log).toEqual(['[{"text":"returned"}]']);
      expect(notes()).toEqual(['now', 'returned']);
    });
  });
});

describe('a store that could not be opened', () => {
  it('refuses every write, statement and hook, saying why', async () => {
    const closed = unopened('It could not be opened.');
    await expect(closed.write(() => 1)).rejects.toThrow('It could not be opened.');
    await expect(closed.writeBlocking(() => 1)).rejects.toThrow('It could not be opened.');
    for (const refused of [
      () => closed.prepare('SELECT 1'),
      () => {
        closed.run('SELECT 1');
      },
      () => {
        closed.runExpecting('SELECT 1', [], 0, 'No');
      },
      () => {
        closed.runReturning('SELECT 1', [], () => undefined);
      },
      () => {
        closed.undo(() => undefined);
      },
      () => {
        closed.followUp(() => undefined);
      },
    ]) {
      expect(refused).toThrow('It could not be opened.');
    }
  });
});
