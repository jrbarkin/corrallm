import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { writeWhole } from '../whole-file';
import { stillRuns } from './lock';
import { isProcessStart } from './process-identity';
import type { ProcessStart } from './process-identity';

/*
 * <profile>/api.json (API Spec §8.1): where the MCP server of the process that owns a profile
 * listens, the app's core or `corrallm serve`, one format for both (core/endpoint.ts writes it).
 * Written once it listens, 0600, so only the user may read it, and removed as it stops, but only
 * the very record its owner wrote: a newer owner's (the next core after a crash, on the same port)
 * survives an old one's late cleanup. `corrallm wait` finds the server through it when
 * CORRALLM_URL doesn't say, while its process lives: by its pid and its start time, as core.lock is,
 * so a pid another process has since been given (its owner killed, the file left behind) finds
 * nothing, rather than whatever listens on its port now.
 */

export interface ApiFile {
  url: string;
  port: number;
  pid: number;
  /** Boot identity and start ticks on Linux; epoch ms on macOS and Windows. */
  started: ProcessStart;
}

const API_FILE = 'api.json';

export function writeApiFile(profile: string, api: ApiFile): Promise<void> {
  return writeWhole(path.join(profile, API_FILE), `${JSON.stringify(api)}\n`, { mode: 0o600 });
}

/**
 * Removes the profile's api.json if it is the record `own` (its owner's, as written): true if it
 * did. Another record there (a newer owner's) is left as it is. Synchronous: it runs as a process
 * exits too.
 *
 * The file is first moved aside, which takes whatever is there at once, then read: a record that
 * isn't `own` is linked back, unless a newer one was written meanwhile (a link never replaces).
 */
export function removeOwnApiFile(profile: string, own: ApiFile): boolean {
  const file = path.join(profile, API_FILE);
  const aside = `${file}.${randomUUID()}.removing`;
  try {
    renameSync(file, aside);
  } catch {
    // None there (or it can't be moved): nothing of this owner's to remove.
    return false;
  }
  try {
    let kept: unknown;
    try {
      kept = JSON.parse(readFileSync(aside, 'utf8'));
    } catch {
      kept = undefined;
    }
    if (isDeepStrictEqual(kept, own)) return true;
    try {
      linkSync(aside, file);
    } catch {
      // A newer record is there already: it stands.
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

/** The profile's api.json, if it has one written by a process that still runs. */
export async function readApiFile(profile: string): Promise<ApiFile | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(profile, API_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { url, port, pid, started } = value as Record<string, unknown>;
  if (
    typeof url !== 'string' ||
    !Number.isSafeInteger(port) ||
    !Number.isSafeInteger(pid) ||
    !isProcessStart(started)
  ) {
    return undefined;
  }
  // Unlike a lock (which must be kept conservatively), an unidentifiable server is not used.
  if (process.platform === 'linux' && typeof started === 'number') return undefined;
  const api = { url, port: port as number, pid: pid as number, started };
  return stillRuns(api) ? api : undefined;
}
