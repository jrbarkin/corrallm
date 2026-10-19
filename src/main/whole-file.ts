import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * Files written and read whole: a canvas's file, api.json, and the profile's JSON stores that stay
 * files (settings.json, tokens.json, usage.json, links.json), each written beside itself and then
 * moved over itself, so it is never left half written.
 */

/** How writeWhole writes a file. */
export interface WriteOptions {
  /** The file's permissions (0o600: only the user may read it), else the process's default. */
  mode?: number;
  /**
   * Forced to disk: the file beside it before it is moved over it, and its folder after, so not
   * even the machine stopping loses it once it is written.
   */
  durable?: boolean;
}

/**
 * Writes a file whole: beside it, then moved over it, so it is never left half written. Each write
 * has its own file beside it, so writes of the same file at once never move each other's.
 */
export async function writeWhole(
  file: string,
  text: string,
  { mode, durable = false }: WriteOptions = {},
): Promise<void> {
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    if (durable) {
      const handle = await open(partial, 'w', mode);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await writeFile(partial, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    }
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  if (durable) await syncFolder(path.dirname(file));
}

/**
 * Reads a store's file, written whole: its JSON object, if it is one of `version`; undefined if
 * there is no file. A file that isn't one (not JSON, not an object, another version: an older
 * corrallm's included) is set aside beside it, as `<name>.rejected-<uuid>.json`, saying where, and
 * reads as none, so that what it held is never written over. Rejects, leaving the file as it is,
 * if it is there but can't be read (its permissions, the disk, too many files open): it may hold
 * what is still good, so it is never read as none, and the store reads it again when next asked.
 */
export async function readWhole(
  file: string,
  version: number,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Set aside below.
  }
  if (isRecord(value) && value.version === version) return value;
  let why = 'it isn’t a JSON object';
  if (isRecord(value)) {
    why =
      value.version === undefined
        ? 'it has no version'
        : `it is of version ${JSON.stringify(value.version)}, not ${String(version)}`;
  }
  const rejected = path.join(
    path.dirname(file),
    `${path.basename(file, '.json')}.rejected-${randomUUID()}.json`,
  );
  await rename(file, rejected);
  console.error(`Could not read ${file} (${why}), so it was moved to ${rejected}.`);
  return undefined;
}

/**
 * The fields of an object a store read that this corrallm doesn't know (a newer one's): all but
 * `known`, to be written back as they were, so that rewriting the store never drops them.
 */
export function unknownFields(value: unknown, known: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)));
}

/** Whether a file can't be read because there is none: missing, or a folder on its path a file. */
function absent(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Forces a folder's entries to disk: a file just moved into it. Windows opens no folder to. */
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(folder, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
