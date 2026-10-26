import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/*
 * The merge service's temporary indexes (B9b Design §9 C6): committing an agent's uncommitted
 * work reads its tip into an index of the core's own, adds the work there and writes its tree,
 * never touching the agent's index. Each job gets one, `<profile>/workspaces/merge/<job>/index`,
 * in a private folder made for that job alone and removed when the job ends. The runner points
 * Git at an index (GIT_INDEX_FILE) only through its `index` option, which takes only a
 * TemporaryIndex, and only this file makes one: no caller's string, environment or argument
 * names another (boundaries.test.ts holds both).
 */

declare const temporary: unique symbol;

/** A job's temporary index, as this file makes it: an absolute path in a private folder of its own. */
export type TemporaryIndex = string & { readonly [temporary]: true };

/** A merge job's id, as the core mints them. */
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Where a profile's merge jobs keep their temporary indexes. */
export function temporaryIndexes(profile: string): string {
  return path.join(profile, 'workspaces', 'merge');
}

/**
 * Makes job `job`'s private folder in `folder` (temporaryIndexes': made private if missing, and a
 * real folder of the user's no one else may write to) and answers its index's path there, which
 * Git makes as it reads a tree into it. A job's folder is made once: one there already (the same
 * job again, or one a crash left) is refused rather than reused, so no index is read that the job
 * didn't write itself; the job removes it and starts again.
 */
export function makeTemporaryIndex(folder: string, job: string): TemporaryIndex {
  if (!JOB.test(job)) throw new TypeError(`${JOB_TEXT} not “${job}”.`);
  if (!path.isAbsolute(folder)) throw new TypeError(`${folder} isn’t an absolute path.`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const found = lstatSync(folder);
  if (found.isSymbolicLink() || !found.isDirectory()) {
    throw new Error(`${folder} isn’t a folder of its own: no temporary index is made there.`);
  }
  if (process.platform !== 'win32') {
    if (found.uid !== process.getuid?.()) throw new Error(`${folder} isn’t the user’s.`);
    if ((found.mode & 0o022) !== 0) throw new Error(`${folder} may be written by others.`);
  }
  const own = path.join(folder, job);
  // Not recursive: it fails if the job's folder is there, whatever it is.
  mkdirSync(own, { mode: 0o700 });
  return path.join(own, 'index') as TemporaryIndex;
}

/** Removes job `job`'s folder and its index, if they are there: as the job ends. */
export function removeTemporaryIndex(folder: string, job: string): void {
  if (!JOB.test(job)) throw new TypeError(`${JOB_TEXT} not “${job}”.`);
  rmSync(path.join(folder, job), { recursive: true, force: true });
}

const JOB_TEXT =
  'A merge job’s id is a letter or digit, then up to 63 letters, digits, dashes or underscores,';
