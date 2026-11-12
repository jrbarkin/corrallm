import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { SYNC_SET_UP } from './checkpointer';
import { CONNECT_IN_WORKER } from './sqlite';
import type { SqlOutput } from './sqlite';

/*
 * The store's writer (Store Writer, step 6a): the one connection that writes core.db, on a thread of
 * its own, so that the kernel's stalls in a commit's writes (a page the system holds back while other
 * programs fill its cache) never land on the core's loop. Its code is a string, run as CommonJS
 * (`eval: true`) like the checkpointer's, since the core's bundles are one file each, and it opens
 * its connection through `CONNECT_IN_WORKER`, so SQLite is still reached only through sqlite.ts. It
 * holds no store logic: main sends it the statements of one write at a time (`savepoint`), then
 * the commit; main flushes the log itself, as it always has (store.ts).
 *
 * Two paths share one MessageChannel, one request outstanding at a time:
 *  - the lane's (`savepoint`, `commit`, `rollback`, `truncate`, `close`): asynchronous, answered by
 *    a message event;
 *  - a blocking write's statements (`sync`): main posts the request, waits on a SharedArrayBuffer
 *    flag (`Atomics.wait`) the writer sets after it posted its answer, and pulls the answer with
 *    `receiveMessageOnPort`, so no message event is emitted for it. Nothing else is in flight
 *    then. Only the pinned blocking writers pay for it (blocking.test.ts).
 *
 * The thread is unref'd, as the checkpointer's is, and its port too except while a request is
 * outstanding: a pending write keeps the process alive as a pending flush does.
 */

/** A value a statement of a write binds: SQLite's input values. */
export type WireValue = null | number | bigint | string | NodeJS.ArrayBufferView;
/** A row a statement gave back. */
export type WireRow = Record<string, SqlOutput>;

/** What an error keeps across the thread (structured clone alone drops `errcode`). */
export interface WireError {
  message: string;
  code?: string;
  errcode?: number;
  errstr?: string;
}

/** A statement of a write on the wire: its SQL text goes once, with its first use. */
export interface WireStep {
  id: number;
  sql?: string;
  params: readonly WireValue[];
  expect?: { changes: number; error: string };
  /** Whether it gives its rows back. */
  rows?: true;
}

/** A statement of a write as the store plans it. */
export interface PlannedStep {
  sql: string;
  params: readonly WireValue[];
  expect?: { changes: number; error: string } | undefined;
  /** Set if it gives its rows back (RETURNING). */
  rows?: true | undefined;
}

/** What the writer answers to a write's statements. */
export type Outcome =
  | {
      /** The log's frames before the transaction began: only if this request began it. */
      frames?: number;
      /** `total_changes()` over the write (those a failed write made included). */
      changes: number;
      /** The rows of each statement that asked for them, in order. */
      rows: WireRow[][];
      error?: undefined;
    }
  | {
      frames?: number;
      changes: number;
      error: unknown;
      /** SQLite rolled the whole transaction back (as on a full disk). */
      lost: boolean;
    };

/** A blocking write's request; the writer answers each with `Sync`. */
export type SyncRequest =
  | { op: 'begin' }
  | { op: 'savepoint' }
  | { op: 'release' }
  | { op: 'rollbackTo' }
  | { op: 'commit' }
  | { op: 'rollback' }
  | { op: 'exec'; sql: string }
  | { op: 'get' | 'all' | 'run'; sql: string; params: readonly WireValue[]; readBigInts?: boolean };

/** The answer to a blocking request. */
export interface Sync {
  /** Whether the connection is in a transaction after the request. */
  tx: boolean;
  /** `begin`: the frames the log held before it. */
  frames?: number;
  /** `release` and `rollbackTo`: `total_changes()` over the savepoint. */
  changes?: number;
  lastInsertRowid?: number | bigint;
  row?: WireRow | undefined;
  rows?: WireRow[];
  error?: WireError;
}

/** What the test seam `StoreDeps.hold` holds: the writer waits there before each statement. */
export type Hold = Int32Array;

const CODE = `
const { workerData } = require('node:worker_threads');
const { file, setUp, flag, hold, port } = workerData;
const options = { timeout: 0 };
let connection;
const texts = new Map();
const statements = new Map();
const marks = [];

const wire = (error) => {
  const out = { message: error instanceof Error ? error.message : String(error) };
  if (error && typeof error.code === 'string') out.code = error.code;
  if (error && typeof error.errcode === 'number') out.errcode = error.errcode;
  if (error && typeof error.errstr === 'string') out.errstr = error.errstr;
  return out;
};
const total = () => Number(connection.prepare('SELECT total_changes() AS count').get().count);
const frames = () => connection.prepare('PRAGMA wal_checkpoint(NOOP)').get().log;
const text = (step) => {
  if (step.sql !== undefined) texts.set(step.id, step.sql);
  const sql = texts.get(step.id);
  if (sql === undefined) throw new Error('The writer received an unknown statement.');
  return sql;
};
const prepared = (step) => {
  const sql = text(step);
  let statement = statements.get(step.id);
  if (statement === undefined) {
    statement = connection.prepare(sql);
    statements.set(step.id, statement);
  }
  return statement;
};
const held = () => {
  if (hold === undefined || Atomics.load(hold, 0) !== 1) return;
  Atomics.add(hold, 1, 1);
  Atomics.notify(hold, 1);
  while (Atomics.load(hold, 0) === 1) Atomics.wait(hold, 0, 1);
};
const rollbackQuietly = (sql) => {
  if (!connection.isTransaction) return;
  try { connection.exec(sql); } catch {}
};

const handlers = {
  savepoint({ begin, steps, deferRelease }) {
    let began;
    let before = 0;
    for (const step of steps) if (step.sql !== undefined) texts.set(step.id, step.sql);
    try {
      if (begin) {
        began = frames();
        connection.exec('BEGIN IMMEDIATE');
      }
      before = total();
      connection.exec('SAVEPOINT nested');
      const rows = [];
      for (const step of steps) {
        held();
        const statement = prepared(step);
        statement.setReadBigInts(false);
        if (step.rows) {
          rows.push(statement.all(...step.params));
        } else {
          const { changes } = statement.run(...step.params);
          if (step.expect && Number(changes) !== step.expect.changes) throw new Error(step.expect.error);
        }
      }
      if (!deferRelease) connection.exec('RELEASE nested');
      return { frames: began, changes: total() - before, rows };
    } catch (error) {
      const kept = began !== undefined && connection.isTransaction ? began : undefined;
      rollbackQuietly('ROLLBACK TO nested; RELEASE nested');
      let changes = 0;
      try { changes = total() - before; } catch {}
      return { frames: kept, changes, error: wire(error), lost: !connection.isTransaction };
    }
  },
  settle({ keep }) {
    try {
      connection.exec(keep ? 'RELEASE nested' : 'ROLLBACK TO nested; RELEASE nested');
      return {};
    } catch (error) {
      rollbackQuietly('ROLLBACK TO nested; RELEASE nested');
      return { error: wire(error), lost: !connection.isTransaction };
    }
  },
  commit() {
    try {
      connection.exec('COMMIT');
      return {};
    } catch (error) {
      rollbackQuietly('ROLLBACK');
      return { error: wire(error) };
    }
  },
  rollback() {
    rollbackQuietly('ROLLBACK');
    return {};
  },
  truncate() {
    try {
      connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      return {};
    } catch (error) {
      return { error: wire(error) };
    }
  },
  close() {
    try {
      connection.close();
      return {};
    } catch (error) {
      return { error: wire(error) };
    }
  },
  sync({ request }) {
    const reply = { tx: false };
    try {
      switch (request.op) {
        case 'begin':
          reply.frames = frames();
          connection.exec('BEGIN IMMEDIATE');
          break;
        case 'savepoint':
          marks.push(total());
          connection.exec('SAVEPOINT nested');
          break;
        case 'release':
          connection.exec('RELEASE nested');
          reply.changes = total() - marks.pop();
          break;
        case 'rollbackTo':
          rollbackQuietly('ROLLBACK TO nested; RELEASE nested');
          reply.changes = total() - marks.pop();
          break;
        case 'commit':
          connection.exec('COMMIT');
          break;
        case 'rollback':
          marks.length = 0;
          rollbackQuietly('ROLLBACK');
          break;
        case 'exec':
          connection.exec(text(request.statement));
          break;
        case 'get':
          { const statement = prepared(request.statement);
            statement.setReadBigInts(request.readBigInts === true);
            reply.row = statement.get(...request.statement.params); }
          break;
        case 'all':
          { const statement = prepared(request.statement);
            statement.setReadBigInts(request.readBigInts === true);
            reply.rows = statement.all(...request.statement.params); }
          break;
        case 'run':
          { const statement = prepared(request.statement);
            statement.setReadBigInts(request.readBigInts === true);
            const result = statement.run(...request.statement.params);
            reply.changes = result.changes;
            reply.lastInsertRowid = result.lastInsertRowid; }
          break;
      }
    } catch (error) {
      reply.error = wire(error);
      if (request.op === 'commit') { rollbackQuietly('ROLLBACK'); marks.length = 0; }
    }
    reply.tx = connection.isTransaction;
    return reply;
  },
};

process.on('exit', () => {
  Atomics.store(flag, 0, 2);
  Atomics.notify(flag, 0);
});

try {
  connection = ${CONNECT_IN_WORKER};
  connection.exec(setUp);
  const mode = connection.prepare('PRAGMA journal_mode').get().journal_mode;
  if (mode !== 'wal') throw new Error('SQLite would not keep a write-ahead log: its journal mode is ' + String(mode));
  port.postMessage({ ready: true });
} catch (error) {
  port.postMessage({ ready: false, error: wire(error) });
}

port.on('message', (message) => {
  const { id, op, sync } = message;
  let reply;
  try {
    reply = handlers[op](message);
  } catch (error) {
    reply = { error: wire(error), lost: !connection.isTransaction, tx: connection.isTransaction, changes: 0 };
  }
  port.postMessage({ id, ...reply });
  if (sync) {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
  if (op === 'close') port.close();
});
`;

/** How its connection is set up: as the checkpointer's, and foreign keys on, no schema functions. */
const WRITER_SET_UP = SYNC_SET_UP;

/** How long a blocking statement may wait on a writer gone quiet, in one-second slices. */
const QUIET_SLICES = 60;

/** Rebuilds an error the writer's thread gave, keeping what SQLite said of it. */
export function errorOf(wired: WireError): Error {
  const error: Error & { code?: string; errcode?: number; errstr?: string } = new Error(
    wired.message,
  );
  if (wired.code !== undefined) error.code = wired.code;
  if (wired.errcode !== undefined) error.errcode = wired.errcode;
  if (wired.errstr !== undefined) error.errstr = wired.errstr;
  return error;
}

interface Asked {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export class Writer {
  readonly worker: Worker;
  readonly #port: MessagePort;
  readonly #flag: Int32Array;
  readonly #asked = new Map<number, Asked>();
  /** The id each distinct SQL text of a write was given. */
  readonly #ids = new Map<string, number>();
  readonly #listeners: ((error: Error) => void)[] = [];
  #next = 0;
  #lost: Error | undefined;
  #closing = false;
  #stopping: Promise<void> | undefined;

  private constructor(worker: Worker, port: MessagePort, flag: Int32Array) {
    this.worker = worker;
    this.#port = port;
    this.#flag = flag;
  }

  /**
   * Starts the writer's thread, which opens its connection to `file` (set up as `setUp`, else as
   * every store connection is) and says when it is ready. Rejects if it can't.
   */
  static async start(
    file: string,
    {
      hold,
      started,
    }: { hold?: Hold | undefined; started?: ((worker: Worker) => void) | undefined },
    setUp = WRITER_SET_UP,
  ): Promise<Writer> {
    const { port1, port2 } = new MessageChannel();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(CODE, {
      eval: true,
      // Results and failures travel by message; this worker writes no application output (#17).
      stdout: true,
      stderr: true,
      workerData: { file, setUp, flag, hold, port: port2 },
      transferList: [port2],
    });
    worker.unref();
    const writer = new Writer(worker, port1, flag);
    const ready = new Promise<void>((resolve, reject) => {
      writer.#asked.set(-1, {
        resolve: (reply) => {
          if (reply.ready === true) resolve();
          else reject(errorOf(reply.error as WireError));
        },
        reject,
      });
    });
    port1.on('message', (reply: Record<string, unknown> & { id?: number }) => {
      writer.#answer(reply.ready === undefined ? (reply.id ?? -2) : -1, reply);
    });
    const lose = (error: Error) => {
      writer.#lose(error);
    };
    worker.on('error', (error: Error) => {
      lose(new Error(`The store’s writer thread failed: ${error.message}`, { cause: error }));
    });
    worker.on('exit', (code) => {
      lose(new Error(`The store’s writer thread ended (exit ${String(code)}).`));
    });
    try {
      started?.(worker);
      await ready;
    } catch (error) {
      const stopped = ready.catch(() => undefined);
      await writer.stop();
      await stopped;
      port1.close();
      throw error;
    }
    return writer;
  }

  /** Calls `listener` once if the thread ends or fails while the store is open (not as it closes). */
  onLost(listener: (error: Error) => void): void {
    if (this.#lost !== undefined) listener(this.#lost);
    else this.#listeners.push(listener);
  }

  /** Why the thread ended, if it did. */
  get lost(): Error | undefined {
    return this.#lost;
  }

  #answer(id: number, reply: Record<string, unknown>): void {
    const asked = this.#asked.get(id);
    this.#asked.delete(id);
    if (this.#asked.size === 0) this.#port.unref();
    asked?.resolve(reply);
  }

  #lose(error: Error): void {
    if (this.#lost !== undefined) return;
    this.#lost = error;
    for (const asked of [...this.#asked.values()]) asked.reject(error);
    this.#asked.clear();
    this.#port.unref();
    // A quiet or errored thread may still be inside SQLite. Stop it before recovery touches WAL.
    void this.stop().catch(() => undefined);
    if (!this.#closing) for (const listener of this.#listeners) listener(error);
  }

  #ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#lost !== undefined) return Promise.reject(this.#lost);
    if (this.#asked.size > 0)
      return Promise.reject(new Error('The store’s writer has a request outstanding.'));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#asked.set(id, { resolve, reject });
      this.#port.ref();
      try {
        this.#port.postMessage({ id, ...request });
      } catch (error) {
        this.#asked.delete(id);
        if (this.#asked.size === 0) this.#port.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Runs one write's statements in a savepoint of its own, beginning the transaction first if
   * `begin`. Rejects only if the thread is lost.
   */
  async savepoint(
    begin: boolean,
    planned: readonly PlannedStep[],
    deferRelease = false,
  ): Promise<Outcome> {
    // A SQL text goes with its first use only: known to the thread once its request is sent.
    const fresh = new Map<string, number>();
    const steps: WireStep[] = planned.map(({ sql, params, expect, rows }) => {
      const known = this.#ids.get(sql) ?? fresh.get(sql);
      const id = known ?? this.#ids.size + fresh.size;
      if (known === undefined) fresh.set(sql, id);
      return {
        id,
        ...(known === undefined ? { sql } : {}),
        params,
        ...(expect === undefined ? {} : { expect }),
        ...(rows === undefined ? {} : { rows }),
      };
    });
    let reply: Record<string, unknown>;
    try {
      reply = await this.#ask({ op: 'savepoint', begin, steps, deferRelease });
      for (const [sql, id] of fresh) this.#ids.set(sql, id);
    } catch (error) {
      // A value that can't cross the thread (a clone error) fails its write alone.
      if (this.#lost !== undefined) throw error;
      return { changes: 0, error, lost: false };
    }
    const outcome = reply as unknown as {
      frames?: number;
      changes: number;
      rows?: WireRow[][];
      error?: WireError;
      lost?: boolean;
    };
    if (outcome.error !== undefined) {
      return {
        ...(outcome.frames === undefined ? {} : { frames: outcome.frames }),
        changes: outcome.changes,
        error: errorOf(outcome.error),
        lost: outcome.lost === true,
      };
    }
    return {
      ...(outcome.frames === undefined ? {} : { frames: outcome.frames }),
      changes: outcome.changes,
      rows: outcome.rows ?? [],
    };
  }

  /** Completes a savepoint whose RETURNING callbacks had to run before it could be released. */
  async settle(keep: boolean): Promise<{ error?: Error; lost?: boolean }> {
    const reply = (await this.#ask({ op: 'settle', keep })) as {
      error?: WireError;
      lost?: boolean;
    };
    return reply.error === undefined
      ? {}
      : { error: errorOf(reply.error), lost: reply.lost === true };
  }

  /** Commits the transaction; rejects with why it couldn't (the writer rolled it back). */
  async commit(): Promise<void> {
    const { error } = (await this.#ask({ op: 'commit' })) as { error?: WireError };
    if (error !== undefined) throw errorOf(error);
  }

  /** Rolls back the transaction going on, if SQLite hasn't already. */
  async rollback(): Promise<void> {
    await this.#ask({ op: 'rollback' });
  }

  /** Checkpoints the log into the database and truncates it, as closing does. */
  async truncate(): Promise<void> {
    const { error } = (await this.#ask({ op: 'truncate' })) as { error?: WireError };
    if (error !== undefined) throw errorOf(error);
  }

  /** Closes the connection (the last one checkpoints and removes the log) and ends the thread. */
  async close(): Promise<void> {
    this.#closing = true;
    if (this.#lost === undefined) {
      try {
        await this.#ask({ op: 'close' });
      } catch {
        // Gone already.
      }
    }
    await this.stop();
  }

  /** Ends the thread and waits for its exit, including when it was lost while still running SQL. */
  stop(): Promise<void> {
    this.#stopping ??= this.worker.terminate().then(() => {
      this.#port.close();
    });
    return this.#stopping;
  }

  /**
   * A blocking write's request: answered before it returns, the loop waiting for it. Throws what
   * SQLite said (rebuilt), or that the thread ended or went quiet for a minute.
   */
  sync(request: SyncRequest): Sync {
    if (this.#lost !== undefined) throw this.#lost;
    if (this.#asked.size > 0) throw new Error('The store’s writer has a request outstanding.');
    if (Atomics.load(this.#flag, 0) === 2) {
      const error = new Error('The store’s writer thread ended.');
      this.#lose(error);
      throw error;
    }
    const id = this.#next++;
    let fresh: { sql: string; id: number } | undefined;
    let wired: unknown = request;
    if ('sql' in request) {
      const known = this.#ids.get(request.sql);
      const statementId = known ?? this.#ids.size;
      if (known === undefined) fresh = { sql: request.sql, id: statementId };
      wired = {
        op: request.op,
        ...('readBigInts' in request ? { readBigInts: request.readBigInts } : {}),
        statement: {
          id: statementId,
          ...(known === undefined ? { sql: request.sql } : {}),
          params: 'params' in request ? request.params : [],
        },
      };
    }
    this.#port.postMessage({ id, op: 'sync', sync: true, request: wired });
    if (fresh !== undefined) this.#ids.set(fresh.sql, fresh.id);
    // A preceding reply's notify can arrive after main consumed its marker and started this
    // request. Notifications only wake the loop; the shared marker proves a reply is ready.
    for (let quiet = 0; Atomics.load(this.#flag, 0) === 0;) {
      if (Atomics.wait(this.#flag, 0, 0, 1000) === 'timed-out' && ++quiet >= QUIET_SLICES) {
        const error = new Error('The store’s writer thread went quiet for a minute.');
        this.#lose(error);
        throw error;
      }
    }
    if (Atomics.load(this.#flag, 0) === 2) {
      const error = new Error('The store’s writer thread ended.');
      this.#lose(error);
      throw error;
    }
    // Reset a reply marker only: a concurrent exit marker must survive for the next request.
    Atomics.compareExchange(this.#flag, 0, 1, 0);
    const received = receiveMessageOnPort(this.#port);
    const reply = received?.message as (Sync & { id: number }) | undefined;
    if (reply?.id !== id) throw new Error('The store’s writer answered out of turn.');
    if (reply.error !== undefined) throw errorOf(reply.error);
    return reply;
  }
}
