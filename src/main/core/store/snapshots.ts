import { closeSync, openSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { backup, connect } from './sqlite';

/*
 * Snapshots of the core's database (Core Database §5), in <profile>/backups/ (the user's alone):
 * copies SQLite's backup API takes of the open database as it goes on being written (never a copy
 * of its files, which would miss its log or tear), each a file of its own (no log beside it),
 * named for when it was taken. The profile keeps the newest SNAPSHOTS_KEPT. A snapshot is taken
 * beside its name and moved there once whole, so one cut short never passes for the latest.
 *
 * The backup reads through a connection of its own, in one step: SQLite refuses a step while its
 * source connection is writing (SQLITE_LOCKED, which node:sqlite reports as "not an error"), and
 * starts again a backup whose source another connection changed between its steps. In one step it
 * copies one consistent read, on Node's thread pool, while the core goes on writing beside it
 * (the write-ahead log never makes a reader and the writer wait for each other).
 */

export const SNAPSHOT_FOLDER = 'backups';
/** How many snapshots the profile keeps: the newest. */
export const SNAPSHOTS_KEPT = 3;

/** A snapshot's name: when it was taken (core-2026-10-19T12-00-00-000Z.db, in UTC). */
const NAME = /^core-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;
/** The files SQLite keeps beside a database while it is open. */
const SIDECARS = ['', '-journal', '-wal', '-shm'];
/** Every page in one step: the most node:sqlite takes. */
const ONE_STEP = 2 ** 31 - 1;

export function snapshotName(at: number): string {
  return `core-${new Date(at).toISOString().replace(/[:.]/g, '-')}.db`;
}

/** When the snapshot `name` was taken, or undefined if `name` is no snapshot's. */
export function snapshotTime(name: string): number | undefined {
  const match = NAME.exec(name);
  if (match === null) return undefined;
  const [, day, hours, minutes, seconds, ms] = match;
  return Date.parse(`${day ?? ''}T${hours ?? ''}:${minutes ?? ''}:${seconds ?? ''}.${ms ?? ''}Z`);
}

/** The profile's snapshots' files, the newest first. */
export async function snapshots(profile: string): Promise<string[]> {
  const folder = path.join(profile, SNAPSHOT_FOLDER);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => snapshotTime(name) !== undefined)
    .sort()
    .reverse()
    .map((name) => path.join(folder, name));
}

/**
 * Takes a snapshot of the database in `source`, taken `at`, into the profile's backups, then
 * forgets all but the newest SNAPSHOTS_KEPT. Resolves with its file.
 */
export async function takeSnapshot(source: string, profile: string, at: number): Promise<string> {
  const folder = path.join(profile, SNAPSHOT_FOLDER);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, snapshotName(at));
  const partial = `${file}.partial`;
  await remove(partial);
  try {
    // Made the user's alone before SQLite writes it, as core.db is.
    closeSync(openSync(partial, 'wx', 0o600));
    const reader = connect(source, { readOnly: true });
    try {
      await backup(reader, partial, ONE_STEP);
    } finally {
      reader.close();
    }
    // The backup keeps the database's write-ahead log mode: a snapshot is one file, with none.
    const copy = connect(partial);
    try {
      copy.exec('PRAGMA journal_mode = DELETE');
    } finally {
      copy.close();
    }
    await rename(partial, file);
  } catch (error) {
    await remove(partial);
    throw error;
  }
  for (const old of (await snapshots(profile)).slice(SNAPSHOTS_KEPT)) await remove(old);
  return file;
}

/** Removes a database's file and those SQLite kept beside it. */
async function remove(file: string): Promise<void> {
  for (const suffix of SIDECARS) await rm(`${file}${suffix}`, { force: true });
}
