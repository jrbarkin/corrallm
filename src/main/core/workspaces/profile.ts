import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PROFILE_ID } from './owned';

/*
 * The profile's id (B9a Design §2, Location): a UUID naming its workspaces' branches
 * (refs/heads/corrallm/<profile>/<workspace>) and their folder in a checkout
 * (.corral/worktrees/<profile>/), so two profiles' workspaces of one repository never meet. Kept in
 * <profile>/workspaces/profile-id, beside the database rather than in it, so a restored database
 * keeps it. Made once; one that can't be read is refused, never replaced by another, since what
 * the workspaces of this profile are named by would change.
 */

/** This profile's id: made, private and forced to disk, the first time it is asked for. */
export function profileId(profile: string): string {
  const folder = path.join(profile, 'workspaces');
  const file = path.join(folder, 'profile-id');
  const read = (): string | undefined => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const id = text.trim();
    if (!PROFILE_ID.test(id)) throw new Error(`${file} doesn’t hold a profile’s id.`);
    return id;
  };
  const kept = read();
  if (kept !== undefined) return kept;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  let handle: number;
  try {
    handle = openSync(file, 'wx', 0o600);
  } catch (error) {
    // Made meanwhile: that one is the profile's.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const made = read();
      if (made !== undefined) return made;
    }
    throw error;
  }
  try {
    writeFileSync(handle, `${id}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  if (process.platform !== 'win32') {
    const directory = openSync(folder, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  return id;
}
