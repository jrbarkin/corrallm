import { Worker } from 'node:worker_threads';

import { faultsOf } from './faults';
import { BACKUP_IN_WORKER, CONNECT_IN_WORKER } from './sqlite';
import type { Connection } from './sqlite';

/*
 * The store's checkpoints, off the core's loop (Core Database §4, the worker-thread fallback for
 * G2): a worker thread with a connection of its own to the database checkpoints the log into it
 * when the store asks. PASSIVE: it never waits for another connection. It syncs as SQLite does,
 * the log before it copies it and the database after, on macOS with F_FULLFSYNC. Once it has
 * copied all of the log, it begins the log anew itself (`beginLog`), since the connection that
 * does so syncs the new log's header as it writes it: begun by the core's next commit, that sync
 * would be on the core's loop. Those syncs wait for the drive, as long as other programs keep it
 * busy. The store commits nothing while a checkpoint goes on, so the two connections never write
 * at once (the core's waits for none: open.ts). Its thread starts with the first checkpoint or snapshot,
 * keeps no process running, and ends as the store closes. Its code is a string, run as CommonJS,
 * since the core's bundles are one file each.
 */

/**
 * How large the log may stay once checkpointed (its file is reused, not regrown): 4 MiB, about
 * what a thousand pages fill, so a burst of writes between checkpoints doesn't regrow it. The
 * connection that begins the log anew cuts it back to this size.
 */
export const JOURNAL_SIZE_LIMIT = 4 * 2 ** 20;

/** At most 256 KiB with SQLite's usual page size, before queued writes get their turn. */
export const VACUUM_PAGES = 64;

/**
 * Begins the log anew, where SQLite may (every frame in it copied into the database, and no
 * reader using it), with a write that changes nothing: the schema's version, as it is. SQLite
 * writes and syncs a new log's header with its first frame, on the connection that writes it; so
 * no commit of the store's begins it.
 */
export function beginLog(connection: Connection): void {
  const version = connection.prepare('PRAGMA user_version').get()?.user_version;
  connection.exec(`PRAGMA user_version = ${String(version)}`);
}

/** What SQLite's checkpoint says it did: frames in the log, and how many of them it copied. */
export interface Checkpointed {
  busy: number;
  log: number;
  checkpointed: number;
}

const CODE = `
const { parentPort, workerData } = require('node:worker_threads');
let connection;
parentPort.on('message', async ({ id, partial, vacuum }) => {
  try {
    if (partial !== undefined) {
      // Its own reader: a backup never uses the checkpointing/writing connection.
      let file = workerData.file;
      let options = { readOnly: true };
      const reader = ${CONNECT_IN_WORKER};
      try {
        await (${BACKUP_IN_WORKER})(reader, partial, { rate: 2 ** 31 - 1 });
      } finally {
        reader.close();
      }
      file = partial;
      options = {};
      const copy = ${CONNECT_IN_WORKER};
      let found;
      try {
        copy.exec('PRAGMA journal_mode = DELETE');
        found = copy.prepare('PRAGMA quick_check').all().map(row => String(row.quick_check));
      } finally {
        copy.close();
      }
      parentPort.postMessage({ id, done: found });
      return;
    }
    if (connection === undefined) {
      const file = workerData.file;
      const options = { timeout: 0 };
      connection = ${CONNECT_IN_WORKER};
      connection.exec(workerData.setUp);
    }
    if (vacuum) {
      if (connection.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 2 ||
          connection.prepare('PRAGMA freelist_count').get().freelist_count === 0) {
        parentPort.postMessage({ id, done: 0 });
        return;
      }
      connection.prepare('PRAGMA incremental_vacuum(${String(VACUUM_PAGES)})').all();
    }
    const done = connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    if (done.log === done.checkpointed) {
      const version = connection.prepare('PRAGMA user_version').get().user_version;
      connection.exec('PRAGMA user_version = ' + String(version));
    }
    parentPort.postMessage({ id, done: vacuum
      ? connection.prepare('PRAGMA freelist_count').get().freelist_count : done });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

/**
 * How the checkpointer's connection syncs, as the store's own does (open.ts), and how large it
 * leaves the log it begins anew.
 */
const SET_UP = [
  'PRAGMA synchronous = NORMAL',
  ...(process.platform === 'darwin'
    ? ['PRAGMA fullfsync = ON', 'PRAGMA checkpoint_fullfsync = ON']
    : []),
  'PRAGMA wal_autocheckpoint = 0',
  `PRAGMA journal_size_limit = ${String(JOURNAL_SIZE_LIMIT)}`,
].join('; ');

interface Asked {
  resolve: (done: Checkpointed | string[] | number) => void;
  reject: (error: Error) => void;
}

export class Checkpointer {
  readonly #file: string;
  #worker: Worker | undefined;
  readonly #asked = new Map<number, Asked>();
  #next = 0;

  constructor(file: string) {
    this.#file = file;
  }

  /**
   * Checkpoints the log into the database, on the worker's thread, and begins it anew there if it
   * copied all of it: what it did.
   */
  checkpoint(): Promise<Checkpointed> {
    return this.#ask() as Promise<Checkpointed>;
  }

  /** Returns free pages still to reclaim, after one bounded pass and its checkpoint. */
  vacuum(): Promise<number> {
    return this.#ask({ vacuum: true }) as Promise<number>;
  }

  /** Copies, converts and checks a snapshot, entirely off the core's loop. */
  async snapshot(partial: string): Promise<void> {
    const found = faultsOf((await this.#ask({ partial })) as string[]);
    if (found !== undefined) {
      throw new Error(
        `The core’s database looks damaged (SQLite’s check of a snapshot of it found: ${found}), so the snapshot was not kept.`,
      );
    }
  }

  #ask(job: { partial?: string; vacuum?: true } = {}): Promise<Checkpointed | string[] | number> {
    const worker = (this.#worker ??= this.#start());
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#asked.set(id, { resolve, reject });
      worker.postMessage({ id, ...job });
    });
  }

  /** Ends the worker's thread, and its connection with it. */
  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    await worker?.terminate();
  }

  #start(): Worker {
    const worker = new Worker(CODE, {
      eval: true,
      // Results and failures travel by message; this worker writes no application output.
      // Default stdio would open the parent's streams even when unused. At shutdown an unused
      // stdout can block forever on macOS if serve's terminal has already hung up (#17).
      stdout: true,
      stderr: true,
      workerData: { file: this.#file, setUp: SET_UP },
    });
    worker.unref();
    worker.on(
      'message',
      ({
        id,
        done,
        error,
      }: {
        id: number;
        done?: Checkpointed | string[] | number;
        error?: string;
      }) => {
        const asked = this.#asked.get(id);
        this.#asked.delete(id);
        if (error !== undefined) asked?.reject(new Error(error));
        else if (done !== undefined) asked?.resolve(done);
      },
    );
    const failed = (error: Error) => {
      for (const asked of this.#asked.values()) asked.reject(error);
      this.#asked.clear();
      if (this.#worker === worker) this.#worker = undefined;
    };
    worker.on('error', failed);
    worker.on('exit', () => {
      failed(new Error('The checkpointer’s thread ended.'));
    });
    return worker;
  }
}
