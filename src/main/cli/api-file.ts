import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeWhole } from '../memory';

/*
 * <profile>/api.json (API Spec §8.1): where the server that holds a profile listens, written by
 * `corrallm serve` once it listens and removed as it stops, only the user may read it. `corrallm
 * wait` finds the server through it when CORRALLM_URL doesn't say, while its process lives.
 */

export interface ApiFile {
  url: string;
  port: number;
  pid: number;
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
  const { url, port, pid } = value as Record<string, unknown>;
  if (typeof url !== 'string' || !Number.isSafeInteger(port) || !Number.isSafeInteger(pid)) {
    return undefined;
  }
  return runs(pid as number) ? { url, port: port as number, pid: pid as number } : undefined;
}

/** Whether a process runs (as anyone) with this pid. */
function runs(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}
