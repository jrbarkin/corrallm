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

/** Written only when a failed WAL flush could not be taken back by cutting and syncing it. */
export async function recordRecovery(
  file: string,
  profile: string,
  prefix: LogPrefix,
  unsafe: readonly string[],
): Promise<void> {
  // If backups cannot be identified, recovery conservatively discards them all. That must not
  // prevent recording the WAL boundary itself on a drive that can still write the marker.
  const kept = await snapshots(profile)
    .then((files) =>
      Promise.all(files.filter((snapshot) => !unsafe.includes(snapshot)).map(identify)),
    )
    .catch(() => []);
  const pending: Pending = { ...prefix, snapshots: kept };
  await writeWhole(`${file}.recovery`, JSON.stringify(pending), { mode: 0o600, durable: true });
}

/** Repairs a pending cut, or refuses, before any SQLite connection can read or checkpoint it. */
export async function recoverLog(file: string, profile: string): Promise<void> {
  const record = `${file}.recovery`;
  let text: string;
  try {
    text = await readFile(record, 'utf8');
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
  // An earlier build left a null record after successful writes.
  if (pending === null) return;
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
  const unsafe: string[] = [];
  for (const snapshot of await snapshots(profile)) {
    const identity = await identify(snapshot);
    if (!pending.snapshots.some((kept) => JSON.stringify(kept) === JSON.stringify(identity))) {
      unsafe.push(snapshot);
    }
  }
  await discardSnapshots(profile, unsafe);
  // Both the cut and the removal of unsafe backups are durable before removing their marker.
  await rm(record);
  await syncFolder(path.dirname(record));
}

/** Removes snapshots that may hold rejected writes, including their directory entries on disk. */
export async function discardSnapshots(profile: string, unsafe: readonly string[]): Promise<void> {
  for (const snapshot of unsafe) await remove(snapshot);
  await syncFolder(path.join(profile, 'backups')).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
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
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(folder, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
