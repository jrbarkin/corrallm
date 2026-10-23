import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { stillRuns } from '../core/lock';
import { isProcessStart } from '../core/process-identity';
import type { ProcessStart } from '../core/process-identity';
import { writeWhole } from '../whole-file';

/*
 * <profile>/api.json (API Spec §8.1): where the server that holds a profile listens, written by
 * `corrallm serve` once it listens and removed as it stops, only the user may read it. `corrallm
 * wait` finds the server through it when CORRALLM_URL doesn't say, while its process lives: by its
 * pid and its start time, as core.lock is, so a pid another process has since been given (serve
 * killed, the file left behind) finds nothing, rather than whatever listens on its port now.
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

/** Removes the profile's api.json. Synchronous: it runs as a process exits. */
export function removeApiFile(profile: string): void {
  rmSync(path.join(profile, API_FILE), { force: true });
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
