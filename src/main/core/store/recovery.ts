import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { writeWhole } from '../../whole-file';
import { remove, snapshots, snapshotTime } from './snapshots';

/** A durable prefix of one WAL generation. Its header binds the offset to its salts/checksums. */
export interface LogPrefix {
  bytes: number;
  header: string;
}

interface KeptSnapshot {
  name: string;
  ino: number;
  size: number;
  modified: number;
}
interface Pending extends LogPrefix {
  snapshots: KeptSnapshot[];
}

/**
 * A recovery record exists before SQLite commits an unflushed write. A successful flush advances
 * its prefix before acknowledging writes. An update's durable fence keeps the old prefix until
 * the update and fence removal are on disk, so an interrupted update can cut to that prefix.
 */
export class Recovery {
  readonly #file: string;
  readonly #profile: string;
  #pending: Pending | undefined;

  constructor(file: string, profile: string) {
    this.#file = `${file}.recovery`;
    this.#profile = profile;
  }

  async begin(prefix: LogPrefix): Promise<void> {
    if (this.#pending !== undefined) return;
    const kept = await Promise.all((await snapshots(this.#profile)).map(identify));
    const pending = { ...prefix, snapshots: kept };
    await writeWhole(this.#file, JSON.stringify(pending), { mode: 0o600, durable: true });
    this.#pending = pending;
  }

  /** Synchronous transactions are only used by tests; they keep the same recovery boundary. */
  beginSync(prefix: LogPrefix): void {
    if (this.#pending !== undefined) throw new Error('A write is already awaiting its flush.');
    // A synchronous transaction cannot take a snapshot meanwhile. Recovery may discard older
    // snapshots conservatively if this test-only transaction fails and cleanup cannot finish.
    const pending = { ...prefix, snapshots: [] };
    writeRecordSync(this.#file, pending);
    this.#pending = pending;
  }

  async flushed(next?: LogPrefix): Promise<void> {
    const pending =
      next === undefined ? undefined : { ...next, snapshots: this.#pending?.snapshots ?? [] };
    await writeWhole(`${this.#file}.updating`, JSON.stringify(this.#pending), {
      mode: 0o600,
      durable: true,
    });
    await writeWhole(this.#file, JSON.stringify(pending ?? null), { mode: 0o600, durable: true });
    this.#pending = pending;
    await eraseFence(this.#file);
  }

  flushedSync(): void {
    writeRecordSync(`${this.#file}.updating`, this.#pending ?? null);
    writeRecordSync(this.#file, null);
    this.#pending = undefined;
    rmSync(`${this.#file}.updating`, { force: true });
    syncFolderSync(path.dirname(this.#file));
  }

  /** Only after the rejected suffix was cut and fsynced, and unsafe snapshots removed. */
  async discarded(): Promise<void> {
    // A power loss must not resurrect an unsafe backup after its recovery record is cleared.
    if (process.platform !== 'win32') {
      const backups = await open(path.join(this.#profile, 'backups'), 'r').catch(
        (error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        },
      );
      if (backups !== undefined) {
        try {
          await backups.sync();
        } finally {
          await backups.close();
        }
      }
    }
    await writeWhole(this.#file, 'null', { mode: 0o600, durable: true });
    this.#pending = undefined;
    await eraseFence(this.#file);
  }
}

/** Repairs a pending cut, or refuses, before any SQLite connection can read or checkpoint it. */
export async function recoverLog(file: string, profile: string): Promise<void> {
  const record = `${file}.recovery`;
  // A fence was forced to disk before replacing the main record. Nothing beyond its old prefix
  // was acknowledged yet: repair that prefix even if the replacement is already visible.
  const fenced = await present(`${record}.updating`);
  let text: string;
  try {
    text = await readFile(fenced ? `${record}.updating` : record, 'utf8');
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  let pending: unknown;
  try {
    pending = JSON.parse(text);
  } catch {
    /* Refused below. */
  }
  if (pending === null && !fenced) return;
  if (!isPending(pending))
    throw new Error(
      'The core’s database recovery record is unreadable; opening is refused to protect rejected writes.',
    );
  const log = await open(`${file}-wal`, 'r+');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await log.read(header, 0, 32, 0);
    if (
      bytesRead !== 32 ||
      header.toString('hex') !== pending.header ||
      (await log.stat()).size < pending.bytes
    ) {
      throw new Error(
        'The core’s database recovery record does not match its WAL; opening is refused to protect rejected writes.',
      );
    }
    await log.truncate(pending.bytes);
    await log.sync();
  } finally {
    await log.close();
  }
  // No SQLite connection is open: its old index must not describe the rejected suffix.
  await rm(`${file}-shm`, { force: true });
  for (const snapshot of await snapshots(profile)) {
    const identity = await identify(snapshot);
    if (!pending.snapshots.some((kept) => JSON.stringify(kept) === JSON.stringify(identity))) {
      await remove(snapshot);
    }
  }
  await new Recovery(file, profile).discarded();
}

async function identify(file: string): Promise<KeptSnapshot> {
  const found = await stat(file);
  return { name: path.basename(file), ino: found.ino, size: found.size, modified: found.mtimeMs };
}
function isPending(value: unknown): value is Pending {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<Pending>;
  return (
    Number.isSafeInteger(entry.bytes) &&
    (entry.bytes ?? 0) >= 32 &&
    typeof entry.header === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.header) &&
    ((entry.bytes ?? 0) - 32) % (24 + Buffer.from(entry.header, 'hex').readUInt32BE(8)) === 0 &&
    Array.isArray(entry.snapshots) &&
    entry.snapshots.length <= 3 &&
    entry.snapshots.every(
      (kept: Partial<KeptSnapshot> | null) =>
        typeof kept === 'object' &&
        kept !== null &&
        typeof kept.name === 'string' &&
        snapshotTime(kept.name) !== undefined &&
        Number.isFinite(kept.ino) &&
        Number.isFinite(kept.size) &&
        Number.isFinite(kept.modified),
    )
  );
}
async function present(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function eraseFence(record: string): Promise<void> {
  await rm(`${record}.updating`, { force: true });
  if (process.platform === 'win32') return;
  const folder = await open(path.dirname(record), 'r');
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
function writeRecordSync(file: string, value: Pending | null): void {
  const partial = `${file}.${randomUUID()}.partial`;
  const fd = openSync(partial, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, file);
  syncFolderSync(path.dirname(file));
}
function syncFolderSync(folder: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(folder, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
