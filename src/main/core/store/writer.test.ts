import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessagePort } from 'node:worker_threads';
import type { Worker } from 'node:worker_threads';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import { MessageStore, MessageTable } from '../delivery/messages';
import { checkStore } from '../selftest';
import { Checkpointer } from './checkpointer';
import { OPEN_DEFAULTS, openStore } from './open';
import { connect, resultCode, SQLITE_FULL } from './sqlite';
import { SYSTEM_DEPS } from './store';
import type { Store, StoreDeps } from './store';
import { Writer } from './writer';

let profile: string;
const stores: Store[] = [];
const writers: Writer[] = [];
const releases: (() => void)[] = [];
let fixtureWriter = false;

beforeAll(async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-writer-before-all-'));
  try {
    const opened = await openStore(folder, {
      ...SYSTEM_DEPS,
      writerStarted: () => {
        fixtureWriter = true;
      },
    });
    if (opened.store === undefined) throw new Error(opened.said.join(' '));
    await opened.store.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-writer-'));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const store of stores.splice(0)) await store.close();
  for (const writer of writers.splice(0)) await writer.close();
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

async function open(writer = true, deps: StoreDeps = SYSTEM_DEPS): Promise<Store> {
  const opened = await openStore(profile, deps, { writer });
  if (opened.store === undefined) throw new Error(opened.said.join(' '));
  stores.push(opened.store);
  return opened.store;
}
async function thread(): Promise<Writer> {
  const seed = await open(false);
  seed.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
  await seed.close();
  const writer = await Writer.start(seed.file, {});
  writers.push(writer);
  return writer;
}
function hold(): Int32Array {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  releases.push(() => {
    Atomics.store(gate, 0, 0);
    Atomics.notify(gate, 0);
  });
  return gate;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const INSERT = 'INSERT INTO note VALUES (?)';
const rows = (store: Store) => store.prepare('SELECT text FROM note ORDER BY rowid').all();

describe('the writer thread', () => {
  it('uses the project’s executor for a store opened in beforeAll', () => {
    expect(fixtureWriter).toBe(OPEN_DEFAULTS.writer);
  });

  it('refuses a blocking request before posting when the writer has marked its exit', async () => {
    const writer = await thread();
    const flagAtomics: { load(array: Int32Array, index: number): number } = Atomics;
    vi.spyOn(flagAtomics, 'load').mockReturnValueOnce(2);
    const sent = vi.spyOn(MessagePort.prototype, 'postMessage');
    expect(() => writer.sync({ op: 'get', sql: 'SELECT 1', params: [] })).toThrow(/thread ended/);
    expect(sent).not.toHaveBeenCalled();
  });

  it('keeps the exit marker if the writer ends as a blocking request starts', async () => {
    const writer = await thread();
    const flagAtomics: { load(array: Int32Array, index: number): number } = Atomics;
    vi.spyOn(flagAtomics, 'load').mockImplementationOnce((array, index) => {
      // The thread can end just after main reads the flag.
      Atomics.store(array, index, 2);
      return 0;
    });
    vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementationOnce(() => undefined);
    vi.spyOn(Atomics, 'wait').mockReturnValueOnce('not-equal');
    expect(() => writer.sync({ op: 'get', sql: 'SELECT 1', params: [] })).toThrow(/thread ended/);
  });
  it('keeps SQLite errors and trigger words across the thread, with a savepoint of each write’s own', async () => {
    const writer = await thread();
    writer.sync({
      op: 'exec',
      sql: "CREATE TRIGGER refuse BEFORE INSERT ON note WHEN NEW.text = 'no' BEGIN SELECT RAISE(ABORT, 'Not this value'); END",
    });
    const first = await writer.savepoint(true, [{ sql: INSERT, params: ['yes'] }]);
    expect(first).toMatchObject({ changes: 1 });
    const failed = await writer.savepoint(false, [{ sql: INSERT, params: ['no'] }]);
    expect(failed).toMatchObject({
      lost: false,
      error: {
        message: 'Not this value',
        code: 'ERR_SQLITE_ERROR',
        errcode: 1811,
        errstr: 'constraint failed',
      },
    });
    const next = await writer.savepoint(false, [{ sql: INSERT, params: ['also yes'] }]);
    expect(next).toMatchObject({ changes: 1 });
    await writer.commit();
    expect(
      writer.sync({ op: 'all', sql: 'SELECT text FROM note ORDER BY rowid', params: [] }).rows,
    ).toEqual([{ text: 'yes' }, { text: 'also yes' }]);
  });

  it('reports a lost transaction and SQLITE_FULL without changing its error code', async () => {
    const writer = await thread();
    const pages = writer.sync({ op: 'get', sql: 'PRAGMA page_count', params: [] }).row?.page_count;
    writer.sync({ op: 'exec', sql: `PRAGMA max_page_count = ${String(Number(pages) + 2)}` });
    const failed = await writer.savepoint(true, [{ sql: INSERT, params: ['x'.repeat(1 << 20)] }]);
    expect(failed).toMatchObject({ lost: true });
    expect('error' in failed && resultCode(failed.error)).toBe(SQLITE_FULL);
    expect(await writer.savepoint(true, [{ sql: INSERT, params: ['fits'] }])).toMatchObject({
      changes: 1,
    });
    await writer.commit();
  });

  it('sends each SQL text once across planned and blocking statements', async () => {
    const writer = await thread();
    const sent = vi.spyOn(MessagePort.prototype, 'postMessage');
    await writer.savepoint(true, [
      { sql: INSERT, params: ['a'] },
      { sql: INSERT, params: ['b'] },
    ]);
    await writer.savepoint(false, [{ sql: INSERT, params: ['c'] }]);
    writer.sync({ op: 'run', sql: INSERT, params: ['d'] });
    writer.sync({ op: 'run', sql: INSERT, params: ['e'] });
    const serialised = JSON.stringify(sent.mock.calls);
    expect(serialised.split(INSERT)).toHaveLength(2);
    await writer.commit();
  });

  it('round-trips a 32 MiB value and RETURNING rows', async () => {
    const writer = await thread();
    const text = 'x'.repeat(32 * 2 ** 20);
    const outcome = await writer.savepoint(true, [
      { sql: `${INSERT} RETURNING text`, params: [text], rows: true },
    ]);
    expect(outcome).toMatchObject({ changes: 1, rows: [[{ text }]] });
    await writer.commit();
    expect(
      writer.sync({ op: 'get', sql: 'SELECT length(text) AS size FROM note', params: [] }).row,
    ).toEqual({ size: text.length });
  });
});

describe('the store with its writer', () => {
  it('checks the writing connection’s pragmas in the native store check', async () => {
    await expect(checkStore(await open())).resolves.toMatch(/synchronous NORMAL/);
  });

  it('refuses an asynchronous transaction before keeping its rows', async () => {
    const store = await open();
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    expect(() =>
      store.tx(() => {
        store.run(INSERT, 'not kept');
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/);
    expect(rows(store)).toEqual([]);
  });

  it('keeps the loop and reads available during a held message write, and acknowledges only after flushing', async () => {
    const gate = hold();
    const flushing = Promise.withResolvers<undefined>();
    const flushed = Promise.withResolvers<undefined>();
    releases.push(() => {
      flushed.resolve(undefined);
    });
    let stopFlush = false;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      hold: gate,
      flush: async (fd) => {
        if (stopFlush) {
          flushing.resolve(undefined);
          await flushed.promise;
        }
        await SYSTEM_DEPS.flush(fd);
      },
    });
    const canvas = '11111111-1111-4111-8111-111111111111' as CanvasId;
    const memory = new CanvasMemory(store);
    await store.write(() => {
      memory.ensure(canvas);
    });
    const messages = new MessageStore(canvas, new MessageTable(store, memory), () => 1000);
    await messages.load();
    messages.add({
      from: 'you',
      to: 'agent:worker',
      kind: 'text',
      origin: 'manual',
      body: 'first',
      state: 'pending',
    });
    Atomics.store(gate, 0, 1);
    stopFlush = true;
    let settled = false;
    const writing = messages.durable().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(Atomics.load(gate, 1)).toBe(1);
    });
    await turn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.prepare('SELECT count(*) AS n FROM message').get()).toEqual({ n: 0 });
    expect(
      messages.add({
        from: 'you',
        to: 'agent:worker',
        kind: 'text',
        origin: 'manual',
        body: 'second',
        state: 'pending',
      }),
    ).toBeDefined();
    expect(settled).toBe(false);
    Atomics.store(gate, 0, 0);
    Atomics.notify(gate, 0);
    await flushing.promise;
    expect(settled).toBe(false);
    flushed.resolve(undefined);
    await writing;
    expect(settled).toBe(true);
  });

  it('uses the current write for a prepared statement and refuses a write through the reader', async () => {
    const store = await open();
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    const read = store.prepare('SELECT count(*) AS n FROM note');
    expect(read.get()).toEqual({ n: 0 });
    const insert = store.prepare(INSERT);
    expect(() => insert.run('outside')).toThrow(/readonly/i);
    await store.writeBlocking(() => {
      expect(insert.run('inside').changes).toBe(1);
      expect(read.get()).toEqual({ n: 1 });
    });
    expect(read.get()).toEqual({ n: 1 });
  });

  it('waits for an open batch and its flush before checkpointing, then drains at close', async () => {
    const gate = hold();
    const store = await open(true, { ...SYSTEM_DEPS, hold: gate });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    const checkpoint = vi.spyOn(Checkpointer.prototype, 'checkpoint');
    Atomics.store(gate, 0, 1);
    const writing = store.write(() => {
      store.run(INSERT, 'held');
    });
    await vi.waitFor(() => {
      expect(Atomics.load(gate, 1)).toBe(1);
    });
    const checking = store.checkpoint();
    await turn();
    expect(checkpoint).not.toHaveBeenCalled();
    Atomics.store(gate, 0, 0);
    Atomics.notify(gate, 0);
    await Promise.all([writing, checking]);
    expect(checkpoint).toHaveBeenCalledOnce();
    const last = store.write(() => {
      store.run(INSERT, 'last');
    });
    await store.close();
    await last;
    const again = await open(false);
    expect(rows(again)).toEqual([{ text: 'held' }, { text: 'last' }]);
  });

  it('defers a checkpoint requested by a plan until that batch has finished', async () => {
    const store = await open();
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    const checkpoint = vi.spyOn(Checkpointer.prototype, 'checkpoint');
    let checking: Promise<void> | undefined;
    const writing = store.write(() => {
      checking = store.checkpoint();
      expect(checkpoint).not.toHaveBeenCalled();
      store.run(INSERT, 'kept');
    });
    await writing;
    await checking;
    expect(rows(store)).toEqual([{ text: 'kept' }]);
  });

  it('restores hooks newest first and fails closed when the thread ends during a batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gate = hold();
    let worker: Worker | undefined;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      hold: gate,
      writerStarted: (started) => {
        worker = started;
      },
    });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    const log: string[] = [];
    const write = (name: string) =>
      store.write(
        () => {
          log.push(`plan ${name}`);
          store.undo(() => log.push(`undo ${name} 1`));
          store.undo(() => log.push(`undo ${name} 2`));
          store.run(INSERT, name);
          if (name === 'b') Atomics.store(gate, 0, 1);
        },
        () => log.push(`failed ${name}`),
      );
    const settled = Promise.allSettled([write('a'), write('b')]);
    await vi.waitFor(() => {
      expect(Atomics.load(gate, 1)).toBe(1);
    });
    await worker?.terminate();
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
    await expect(store.write(() => undefined)).rejects.toThrow(/could not be written/);
    expect(() => store.prepare('SELECT 1')).toThrow(/could not be written/);
    await store.close();
    expect(rows(await open(false))).toEqual([]);
  });

  it('takes back an unacknowledged commit when the writer ends before replying', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let worker: Worker | undefined;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      writerStarted: (started) => {
        worker = started;
      },
    });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    await store.write(() => {
      store.run(INSERT, 'durable');
    });
    const commit = Reflect.get(Writer.prototype, 'commit');
    vi.spyOn(Writer.prototype, 'commit').mockImplementationOnce(async function (this: Writer) {
      await commit.call(this);
      await worker?.terminate();
    });
    await expect(
      store.write(() => {
        store.run(INSERT, 'not acknowledged');
      }),
    ).rejects.toThrow(/could not be written/);
    await store.close();
    expect(rows(await open(false))).toEqual([{ text: 'durable' }]);
  });

  it('removes a snapshot containing a commit whose reply was still in flight when the writer ended', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let worker: Worker | undefined;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      writerStarted: (started) => {
        worker = started;
      },
    });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    await store.write(() => {
      store.run(INSERT, 'durable');
    });
    const commit = Reflect.get(Writer.prototype, 'commit');
    let snapshot: string | undefined;
    vi.spyOn(Writer.prototype, 'commit').mockImplementationOnce(async function (this: Writer) {
      await commit.call(this);
      snapshot = await store.snapshot();
      const read = connect(snapshot, { readOnly: true });
      try {
        expect(read.prepare('SELECT text FROM note ORDER BY rowid').all()).toEqual([
          { text: 'durable' },
          { text: 'not acknowledged' },
        ]);
      } finally {
        read.close();
      }
      await worker?.terminate();
    });
    await expect(
      store.write(() => {
        store.run(INSERT, 'not acknowledged');
      }),
    ).rejects.toThrow(/could not be written/);
    await store.close();
    expect(snapshot).toBeDefined();
    expect(await readdir(path.join(profile, 'backups'))).not.toContain(
      path.basename(snapshot ?? ''),
    );
  });

  it('keeps durable rows and takes back the held flush when the writer ends', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const began = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    releases.push(() => {
      release.resolve(undefined);
    });
    let blocked = false;
    let worker: Worker | undefined;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      writerStarted: (started) => {
        worker = started;
      },
      flush: async (fd) => {
        if (blocked) {
          began.resolve(undefined);
          await release.promise;
        }
        await SYSTEM_DEPS.flush(fd);
      },
    });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    await store.write(() => {
      store.run(INSERT, 'durable');
    });
    blocked = true;
    const writing = store.write(() => {
      store.run(INSERT, 'unflushed');
    });
    const rejected = expect(writing).rejects.toThrow(/could not be written/);
    await began.promise;
    await worker?.terminate();
    expect(() => store.prepare('SELECT 1')).toThrow(/could not be written/);
    await expect(store.write(() => undefined)).rejects.toThrow(/could not be written/);
    release.resolve(undefined);
    await rejected;
    await store.close();
    expect(rows(await open(false))).toEqual([{ text: 'durable' }]);
  });

  it('keeps an acknowledged commit when an idle writer ends', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let worker: Worker | undefined;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      writerStarted: (started) => {
        worker = started;
      },
    });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    await store.write(() => {
      store.run(INSERT, 'durable');
    });
    await worker?.terminate();
    await expect(store.write(() => undefined)).rejects.toThrow(/could not be written/);
    await store.close();
    expect(rows(await open(false))).toEqual([{ text: 'durable' }]);
  });

  it('waits for a held write at close and refuses any later write', async () => {
    const gate = hold();
    const store = await open(true, { ...SYSTEM_DEPS, hold: gate });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    Atomics.store(gate, 0, 1);
    const writing = store.write(() => {
      store.run(INSERT, 'held');
    });
    await vi.waitFor(() => {
      expect(Atomics.load(gate, 1)).toBe(1);
    });
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    await turn();
    expect(closed).toBe(false);
    await expect(store.write(() => undefined)).rejects.toThrow(/closed/);
    Atomics.store(gate, 0, 0);
    Atomics.notify(gate, 0);
    await Promise.all([writing, closing]);
    expect(rows(await open(false))).toEqual([{ text: 'held' }]);
  });

  it('joins failed-store cleanup when the writer ends during the closing snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let worker: Worker | undefined;
    const store = await open(true, {
      ...SYSTEM_DEPS,
      writerStarted: (started) => {
        worker = started;
      },
    });
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    await store.write(() => {
      store.run(INSERT, 'durable');
    });
    const copying = Reflect.get(Checkpointer.prototype, 'snapshot');
    vi.spyOn(Checkpointer.prototype, 'snapshot').mockImplementationOnce(async function (
      this: Checkpointer,
      partial,
    ) {
      await copying.call(this, partial);
      await worker?.terminate();
    });
    // Both possible cleanup paths observe the same worker-termination barrier.
    const close = Reflect.get(Checkpointer.prototype, 'close');
    let first: Promise<void> | undefined;
    vi.spyOn(Checkpointer.prototype, 'close').mockImplementation(async function (
      this: Checkpointer,
    ) {
      const done = close.call(this);
      first ??= done;
      await first;
      await done;
    });
    const ended = vi.spyOn(Writer.prototype, 'close');
    await store.close();
    expect(ended).toHaveBeenCalledOnce();
    expect(rows(await open(false))).toEqual([{ text: 'durable' }]);
  });

  it.each([false, true])('a result callback rejects only its write, writer %s', async (writer) => {
    const store = await open(writer);
    store.exec('CREATE TABLE note (text TEXT NOT NULL) STRICT');
    const results = await Promise.allSettled([
      store.write(() => {
        store.run(INSERT, 'before');
      }),
      store.write(() => {
        store.runReturning(`${INSERT} RETURNING text`, ['refused'], () => {
          throw new Error('The result was refused');
        });
      }),
      store.write(() => {
        store.run(INSERT, 'after');
      }),
    ]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(rows(store)).toEqual([{ text: 'before' }, { text: 'after' }]);
  });
});
