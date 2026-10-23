import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { Children } from '../core/children';
import type { ChildSystem } from '../core/children';
import { isProcessStart } from '../core/process-identity';
import type { TestChildren } from './test-children';

/** Crash-test teardown must finish the parent and its recorded CLI groups before removal. */
export async function cleanupCrash(
  directory: string,
  profile: string,
  children: Pick<TestChildren, 'close'>,
  system?: ChildSystem,
): Promise<void> {
  // No more CLI can be spawned or recorded after the owner's exit and pipe closure.
  await children.close();
  const file = path.join(profile, 'sessions', 'pids.json');
  const before = await recorded(file);
  // Use the core's start-time and private-group checks, grace and whole-group escalation.
  await new Children(profile, system).recover();
  const remaining = await recorded(file);
  const alive = system?.alive ?? groupAlive;
  const survivors = before.filter((pid) => alive(pid));
  if (remaining.length || survivors.length) {
    throw new Error(
      `Crash-test CLI groups ${[...new Set([...remaining, ...survivors])].join(', ')} did not stop; the folder was kept.`,
    );
  }
  await rm(directory, { recursive: true, force: true });
}

async function recorded(file: string): Promise<number[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (
    typeof data !== 'object' ||
    data === null ||
    !('version' in data) ||
    data.version !== 1 ||
    !('children' in data) ||
    !Array.isArray(data.children)
  ) {
    throw new Error('The crash-test CLI registry could not be read; the folder was kept.');
  }
  return data.children.map((row: unknown) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('pid' in row) ||
      typeof row.pid !== 'number' ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 1 ||
      !('started' in row) ||
      !isProcessStart(row.started)
    ) {
      throw new Error('The crash-test CLI registry has an invalid identity; the folder was kept.');
    }
    return row.pid;
  });
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
