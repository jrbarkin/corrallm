import { Worker } from 'node:worker_threads';

import { CONNECT_IN_WORKER } from './sqlite';

/*
 * The store's checkpoints, off the core's loop (Core Database §4, the worker-thread fallback for
 * G2): a worker thread with a connection of its own to the database checkpoints the log into it
 * when the store asks. PASSIVE: it never waits for the core's connection, which goes on committing
 * meanwhile. It syncs as SQLite does, the log before it copies it and the database after, on macOS
 * with F_FULLFSYNC, before the core's connection may begin the log anew over what it copied; those
 * syncs wait for the drive, as long as other programs keep it busy, which on the loop would stall
 * the core. Its thread starts with the first checkpoint, keeps no process running, and ends as the
 * store closes. Its code is a string, run as CommonJS, since the core's bundles are one file each.
 */

/** What SQLite's checkpoint says it did: frames in the log, and how many of them it copied. */
export interface Checkpointed {
  busy: number;
  log: number;
  checkpointed: number;
}

const CODE = `
const { parentPort, workerData } = require('node:worker_threads');
let connection;
parentPort.on('message', ({ id }) => {
  try {
    if (connection === undefined) {
      const file = workerData.file;
      const options = { timeout: 0 };
      connection = ${CONNECT_IN_WORKER};
      connection.exec(workerData.setUp);
    }
    parentPort.postMessage({ id, done: connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

/** How the checkpointer's connection syncs: as the store's own does (open.ts). */
const SET_UP = [
  'PRAGMA synchronous = NORMAL',
  ...(process.platform === 'darwin'
    ? ['PRAGMA fullfsync = ON', 'PRAGMA checkpoint_fullfsync = ON']
    : []),
  'PRAGMA wal_autocheckpoint = 0',
].join('; ');

interface Asked {
  resolve: (done: Checkpointed) => void;
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

  /** Checkpoints the log into the database, on the worker's thread: what it did. */
  checkpoint(): Promise<Checkpointed> {
    const worker = (this.#worker ??= this.#start());
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#asked.set(id, { resolve, reject });
      worker.postMessage({ id });
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
      workerData: { file: this.#file, setUp: SET_UP },
    });
    worker.unref();
    worker.on(
      'message',
      ({ id, done, error }: { id: number; done?: Checkpointed; error?: string }) => {
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
