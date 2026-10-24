import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

/*
 * The owned root: the folder a repository's workspaces' checkouts go in (B9a Design §2, Location).
 * Q32 is yes (a CLI trusts a worktree inside a folder it trusts), so it is inside the picked
 * checkout, at <checkout>/.corral/worktrees/<profile>/, each workspace's checkout a folder of it
 * named by its id. A path below the checkout by string prefix is not enough: every folder from the
 * checkout's real path down is checked to be a real folder (no symlink, which a repository could
 * commit), the user's, and the last one private and marked as the repository's by the core, which
 * made it. The marker is kept in the repository's common Git directory, never in the checkout,
 * where a `git clean -fdx` would take it (Git spares the checkouts themselves): it names the
 * repository record, the root's path and the root folder's inode, so a folder put in its place
 * isn't taken for it. One already there that the core didn't mark is refused, never adopted, unless
 * it is empty. Nothing is written in it before it is verified. This is checkout isolation, not a
 * sandbox: a process running as the user may still change it, so it is verified at every use.
 */

/** The owned subtree's line in Git's local info/exclude (never the tracked .gitignore). */
export const EXCLUDED = '/.corral/worktrees/';
/** The folder of the common Git directory the core's markers are kept in. */
const MARKERS = 'corrallm';
const MAX_MARKER_BYTES = 4096;
const MAX_EXCLUDE_BYTES = 1024 * 1024;

export type OwnedRootFault =
  /** Not there (verifying only). */
  | 'missing'
  /** A symlink along it, or a checkout not given by its real path. */
  | 'symlinked'
  /** Something along it that isn't a folder. */
  | 'not-folder'
  /** A folder the core didn't make, another user's, another repository's, or one others may write. */
  | 'unowned'
  /** A root that isn't inside the checkout. */
  | 'outside'
  /** Git's local info/exclude can't be written safely. */
  | 'exclude';

export class OwnedRootError extends Error {
  readonly code: OwnedRootFault;
  constructor(code: OwnedRootFault, message: string) {
    super(message);
    this.name = 'OwnedRootError';
    this.code = code;
  }
}

/** What of a repository its owned root is checked against. */
export interface OwnedRepository {
  id: string;
  realRoot: string;
  /** Its common Git directory, by its real path: where the root's marker is kept. */
  commonDir: string;
  ownedRoot: string;
}

/** A profile's id: a UUID, so never a path of its own. */
export const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a repository's workspaces' checkouts go, for this profile: inside its checkout. */
export function projectOwnedRoot(realRoot: string, profile: string): string {
  if (!PROFILE_ID.test(profile)) throw new TypeError('That isn’t a profile’s id.');
  return path.join(realRoot, '.corral', 'worktrees', profile);
}

/** Makes the owned root if it is missing, and verifies it: before anything is written in it. */
export function ensureOwnedRoot(repository: OwnedRepository): void {
  walk(repository, true);
}

/** Verifies the owned root, making nothing. */
export function verifyOwnedRoot(repository: OwnedRepository): void {
  walk(repository, false);
}

function walk({ id, realRoot, commonDir, ownedRoot }: OwnedRepository, make: boolean): void {
  for (const [what, folder] of [
    ['checkout', realRoot],
    ['Git directory', commonDir],
  ] as const) {
    let real: string;
    try {
      real = realpathSync(folder);
    } catch {
      throw new OwnedRootError('missing', `The ${what} ${folder} is missing.`);
    }
    if (real !== folder) {
      throw new OwnedRootError('symlinked', `The ${what} ${folder} isn’t its real path.`);
    }
  }
  const relative = path.relative(realRoot, ownedRoot);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new OwnedRootError('outside', `${ownedRoot} isn’t inside the checkout.`);
  }
  let at = realRoot;
  for (const part of relative.split(path.sep)) {
    at = path.join(at, part);
    let found = stat(at);
    if (found === undefined) {
      if (!make) throw new OwnedRootError('missing', `${at} is missing.`);
      mkdirSync(at, { mode: 0o700 });
      found = stat(at);
    }
    check(at, found);
  }
  const found = lstatSync(ownedRoot, { bigint: true });
  if (process.platform !== 'win32' && (Number(found.mode) & 0o077) !== 0) {
    throw new OwnedRootError('unowned', `${ownedRoot} isn’t private.`);
  }
  const markers = path.join(commonDir, MARKERS);
  const marker = path.join(
    markers,
    `owned-root-${createHash('sha256').update(ownedRoot).digest('hex').slice(0, 32)}.json`,
  );
  const expected = `${JSON.stringify({
    corrallm: 'owned-root',
    repository: id,
    root: ownedRoot,
    inode: found.ino.toString(),
  })}\n`;
  const kept = markerText(markers, marker);
  if (kept === expected) return;
  // Not marked as this folder of this repository's: only an empty one (just made, or one a crash
  // left before its marker, or put in its place) has nothing in it to protect, and is taken.
  if (!make || readdirSync(ownedRoot).length > 0) {
    throw new OwnedRootError(
      'unowned',
      kept === undefined
        ? `${ownedRoot} wasn’t made by corrallm.`
        : `${ownedRoot} isn’t the folder corrallm made for this repository.`,
    );
  }
  const folder = stat(markers);
  if (folder === undefined) mkdirSync(markers, { mode: 0o700 });
  writeDurably(marker, expected, 0o600);
}

function stat(at: string): Stats | undefined {
  try {
    return lstatSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function check(at: string, found: Stats | undefined): void {
  if (found === undefined) throw new OwnedRootError('missing', `${at} is missing.`);
  if (found.isSymbolicLink()) throw new OwnedRootError('symlinked', `${at} is a symlink.`);
  if (!found.isDirectory()) throw new OwnedRootError('not-folder', `${at} isn’t a folder.`);
  if (process.platform !== 'win32' && found.uid !== process.getuid?.()) {
    throw new OwnedRootError('unowned', `${at} is another user’s.`);
  }
}

/** A marker's text (none if there is none), never through a symlink. */
function markerText(markers: string, marker: string): string | undefined {
  const folder = stat(markers);
  if (folder === undefined) return undefined;
  if (folder.isSymbolicLink()) throw new OwnedRootError('symlinked', `${markers} is a symlink.`);
  if (!folder.isDirectory()) throw new OwnedRootError('not-folder', `${markers} isn’t a folder.`);
  const found = stat(marker);
  if (found === undefined) return undefined;
  if (!found.isFile() || found.size > MAX_MARKER_BYTES) {
    throw new OwnedRootError('unowned', `${marker} isn’t corrallm’s.`);
  }
  return readFileSync(marker, 'utf8');
}

/**
 * Adds EXCLUDED to the repository's local info/exclude (in its common Git directory), keeping
 * what it holds, once: so the checkout's status, `git add -A` and its agents never take the
 * workspaces for its files. Never through a symlink, never a file it can't read whole.
 */
export function excludeOwnedRoot(commonDir: string): void {
  const info = path.join(commonDir, 'info');
  const exclude = path.join(info, 'exclude');
  const folder = stat(info);
  if (folder === undefined) mkdirSync(info, { mode: 0o755 });
  else if (folder.isSymbolicLink() || !folder.isDirectory()) {
    throw new OwnedRootError('exclude', `${info} isn’t a folder.`);
  }
  const file = stat(exclude);
  let text = '';
  if (file !== undefined) {
    if (file.isSymbolicLink() || !file.isFile() || file.size > MAX_EXCLUDE_BYTES) {
      throw new OwnedRootError('exclude', `${exclude} isn’t a file it can keep.`);
    }
    text = readFileSync(exclude, 'utf8');
  }
  if (text.split('\n').some((line) => line.replace(/\r$/, '') === EXCLUDED)) return;
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  writeDurably(exclude, `${text}${separator}${EXCLUDED}\n`, file ? file.mode & 0o777 : 0o644);
}

/** Writes `file` whole, forced to disk, by a rename: never through what is there. */
function writeDurably(file: string, text: string, mode: number): void {
  const partial = `${file}.corrallm-${randomUUID()}`;
  try {
    const handle = openSync(partial, 'wx', mode);
    try {
      writeFileSync(handle, text);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(partial, file);
    if (process.platform !== 'win32') {
      const folder = openSync(path.dirname(file), 'r');
      try {
        fsyncSync(folder);
      } finally {
        closeSync(folder);
      }
    }
  } finally {
    rmSync(partial, { force: true });
  }
}
