import path from 'node:path';

import type { CanvasId } from '../../../shared/canvas';
import { parseRunCheckpoint } from '../../../shared/run';
import type { RunCheckpoint } from '../../../shared/run';
import { CanvasMemory } from '../../memory';
import type { Remembered } from '../../memory';
import { RunJournal } from '../../run-journal';
import { mintTrustedPath as trusted } from '../host';
import { openStore, STORE_FILE } from './open';
import { connect } from './sqlite';
import type { Connection } from './sqlite';
import type { Store, StoreDeps } from './store';

/*
 * For tests: a profile's database, seeded and read through the store's API, as the core keeps it
 * (never by writing its files).
 */

/** The profile's store, opened as the core opens it: the test fails if it can't be. */
export async function openTestStore(profile: string, deps?: StoreDeps): Promise<Store> {
  const { store, said } = await openStore(profile, deps);
  if (store === undefined) throw new Error(said.join(' '));
  return store;
}

/** What a test keeps of a canvas: its file, its project folder and its agents' conversations. */
export interface Kept {
  file?: string;
  project?: string;
  conversations?: Remembered['conversations'];
}

/**
 * Keeps canvases in the profile, while no core has it open, as the app would once each was opened
 * or saved and its folder picked there: each one's file, folder and conversations, in this order
 * (the last used most recently), replacing what was kept of it.
 */
export async function keepCanvases(
  profile: string,
  canvases: Readonly<Record<string, Kept>>,
): Promise<void> {
  const store = await openTestStore(profile);
  try {
    const memory = new CanvasMemory(store);
    for (const [canvas, { file, project, conversations = {} }] of Object.entries(canvases)) {
      await memory.setFile(canvas as CanvasId, file === undefined ? undefined : trusted(file));
      await memory.update(canvas as CanvasId, (remembered) => ({
        ...(remembered.file === undefined ? {} : { file: remembered.file }),
        ...(project === undefined ? {} : { project: trusted(project) }),
        conversations,
      }));
    }
    await memory.flush();
  } finally {
    await store.close();
  }
}

/**
 * Uses the profile's run journal, while no core has the profile open, as the app would: through
 * its canvases' windows.
 */
async function withJournal(profile: string, use: (journal: RunJournal) => Promise<void>) {
  const store = await openTestStore(profile);
  try {
    const memory = new CanvasMemory(store);
    await use(
      new RunJournal(path.join(profile, 'runs'), { store, memory, projectOf: () => undefined }),
    );
  } finally {
    await store.close();
  }
}

/** Makes `canvas` the one the profile had open last, as a window opening it does. */
export function openedLast(profile: string, canvas: CanvasId): Promise<void> {
  return withJournal(profile, (journal) => journal.opened(canvas));
}

/** Forgets the canvas's run, as a window journaling none does: it opens from its file again. */
export function forgetRun(profile: string, canvas: CanvasId): Promise<void> {
  return withJournal(profile, async (journal) => {
    await journal.save(canvas, (await journal.get(canvas)).token, null);
  });
}

/** A connection to the profile's database that only reads: what is on disk, whoever has it open. */
export function onDisk(profile: string): Connection {
  return connect(path.join(profile, STORE_FILE), { readOnly: true });
}

/** Reads from what is on disk in the profile's database, whoever has it open. */
export function readOnDisk<T>(profile: string, read: (connection: Connection) => T): T {
  const connection = onDisk(profile);
  try {
    return read(connection);
  } finally {
    connection.close();
  }
}

/**
 * The canvas's run as journaled on disk, as the journal restores it (whoever has the database
 * open): none if it has none.
 */
export function journaledRun(profile: string, canvas: string): RunCheckpoint | undefined {
  const row = readOnDisk(profile, (disk) =>
    disk
      .prepare(
        `SELECT json_extract(state, '$.version') AS version, json_extract(state, '$.state') AS state,
           json_extract(state, '$.messages') AS messages, workflow, updated_at AS updatedAt
         FROM run WHERE canvas_id = ?`,
      )
      .get(canvas),
  );
  return row === undefined ? undefined : parseRunCheckpoint({ ...row });
}

/** Where each party has read to in the canvas's messages, as on disk: none if none has. */
export function readPositions(profile: string, canvas: string): Record<string, number> {
  const rows = readOnDisk(profile, (disk) =>
    disk.prepare('SELECT party, seq FROM read_position WHERE canvas_id = ?').all(canvas),
  );
  return Object.fromEntries(rows.map(({ party, seq }) => [String(party), Number(seq)]));
}

/**
 * Makes every write to `table` in the profile's database (of `canvas`'s rows alone, if given) fail,
 * saying `why`, as a full disk would, whoever has it open, until what it returns is called.
 */
export function refuseWrites(
  profile: string,
  table: string,
  why: string,
  canvas?: string,
): () => void {
  const said = why.replaceAll("'", "''");
  const changes = { INSERT: 'NEW', UPDATE: 'NEW', DELETE: 'OLD' };
  writeOnDisk(
    profile,
    Object.entries(changes)
      .map(([change, row]) => {
        const when = canvas === undefined ? '' : `WHEN ${row}.canvas_id = '${canvas}'`;
        return `CREATE TRIGGER refuse_${change}_${table} BEFORE ${change} ON ${table} ${when}
          BEGIN SELECT RAISE(ABORT, '${said}'); END;`;
      })
      .join('\n'),
  );
  return () => {
    writeOnDisk(
      profile,
      Object.keys(changes)
        .map((change) => `DROP TRIGGER refuse_${change}_${table};`)
        .join('\n'),
    );
  };
}

/**
 * Runs `sql` on the profile's database through a connection of its own, whoever has it open: what
 * no store's API would write (a fault, a row damaged).
 */
export function writeOnDisk(profile: string, sql: string): void {
  const writer = connect(path.join(profile, STORE_FILE));
  try {
    writer.exec(sql);
  } finally {
    writer.close();
  }
}
