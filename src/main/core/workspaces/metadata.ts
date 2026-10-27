import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

/*
 * The Git metadata a workspace's Git writes go through (B9a Design §2, Git execution boundary), in
 * the repository's common Git directory: verified as the owned root is, before every such write and
 * again after it, so none lands outside the repository's own Git directory. Every folder Git writes
 * in (or makes a folder in) must be a real folder of the user's, and every file it writes in place
 * a real file of the user's with no other name: a link anywhere along it, which would carry Git's
 * write elsewhere, refuses the operation.
 *
 * What a workspace's Git writes there (traced with Git's files and reftable ref backends, packed
 * refs and relative worktree paths) is all this checks:
 *
 * - a generated branch made (`update-ref`) or deleted (`update-ref -d`): its loose ref, by its
 *   path below `refs/` (each folder made as needed), its reflog, by the same path below `logs/`
 *   (appended in place, so it must have one name only), `packed-refs` (rewritten when a packed
 *   branch is deleted, through a link if it is one), and, in a repository keeping refs in reftable,
 *   the `reftable/` folder its tables are written in;
 * - a worktree registered (`worktree add`), populated (`read-tree`, its index) or removed
 *   (`worktree remove`): `worktrees/`, in which Git makes or deletes its registration folder.
 *
 * Nothing else is written there for a workspace: no object (no fetch, gc or maintenance, and no
 * filter, so no LFS), no hook's output, and no configuration (the runner keeps worktree paths
 * absolute, so `worktree add` never records relative ones in it). The core's own writes there (the
 * owned root's marker, `info/exclude`) are checked where they are made (owned.ts).
 *
 * B9b's merges write more (B9b Design §9 C10, traced with Git 2.50 and 2.39, main and linked
 * checkouts, files and reftable refs), checked the same way (`verifyMergeWrites`):
 *
 * - preparing a merge writes objects only (its trees, a conflict's blobs, its commits, and a
 *   checkpoint's blobs): loose ones in `objects/` and the fan-out folder each goes in, which Git
 *   makes there if it is missing, and a pack in `objects/pack/` for a file a checkpoint adds past
 *   `core.bigFileThreshold`. Alternates are stores Git only reads, never written: not checked;
 * - the install writes, in the destination checkout's own Git directory (the common one for a main
 *   checkout, its registration's folder for a linked one), `index` (replaced whole), `logs/HEAD`
 *   (appended) and `ORIG_HEAD` (replaced whole), and its branch's loose ref and reflog in the common
 *   directory; in a reftable repository, the tables in `reftable/` (the checkout's own, for a
 *   linked one) hold the refs, ORIG_HEAD and the logs instead;
 * - a checkpoint writes the generated branch's ref and log, and the agent's checkout's `logs/HEAD`
 *   and `index`, likewise.
 *
 * A checkout's files are written by Git's own checkout, never through a link in a leading path,
 * and are not this file's.
 */

export type MetadataFault =
  /** A link along the path. */
  | 'symlinked'
  /** Something Git writes in that isn't a folder, or a file it writes that isn't a regular one. */
  | 'not-folder'
  | 'not-file'
  /** A file Git appends to with another name too: the write would reach that name. */
  | 'linked'
  /** Another user's. */
  | 'unowned'
  /** The registration Git is to write in or remove isn't there. */
  | 'missing'
  /** It can't be read. */
  | 'unreadable';

export class GitMetadataError extends Error {
  readonly code: MetadataFault;
  constructor(code: MetadataFault, message: string) {
    super(message);
    this.name = 'GitMetadataError';
    this.code = code;
  }
}

/** What a workspace's Git is to write in the common Git directory. */
export interface MetadataWrites {
  /** Its generated branch's full ref (`refs/heads/...`): made, moved or deleted. */
  branch: string;
  /** Its registration's folder name in `worktrees/`, once Git has made it. */
  registration?: string;
}

/**
 * Throws (GitMetadataError) unless every path of the common Git directory the workspace's Git
 * writes through is the user's own, with no link along it: nothing is written otherwise.
 */
export function verifyGitMetadata(commonDir: string, writes: MetadataWrites): void {
  realFolder(commonDir);
  branch(commonDir, writes.branch);
  for (const name of ['reftable', 'worktrees']) {
    const at = path.join(commonDir, name);
    const there = found(at);
    if (there !== undefined) folder(at, there);
  }
  if (writes.registration !== undefined) {
    const name = writes.registration;
    if (name === '' || name === '.' || name === '..' || name.includes(path.sep)) {
      throw new TypeError(`${name} isn’t a registration’s name.`);
    }
    const at = path.join(commonDir, 'worktrees', name);
    const there = found(at);
    if (there === undefined) throw new GitMetadataError('missing', `${at} is missing.`);
    folder(at, there);
  }
}

/** What a merge's Git is to write (B9b Design §9 C10): any of these. */
export interface MergeWrites {
  /** Objects, loose or in a pack, in the common directory's object store: a merge's preparation. */
  objects?: boolean;
  /**
   * The Git directory of the checkout whose `index`, `logs/HEAD` and `ORIG_HEAD` Git writes: the
   * destination's for the install, the agent's for a checkpoint. The common directory itself, or
   * one of its registrations (`worktrees/<name>`).
   */
  checkout?: string;
  /** A branch's full ref (`refs/heads/...`) Git moves: its loose ref and reflog, or reftable. */
  branch?: string;
}

/**
 * Throws (GitMetadataError) unless every path a merge's Git writes through (`writes`) is the
 * user's own, with no link along it, as B9a's are checked: called before each of a merge's writes
 * and after it, a failed one too, so nothing lands outside the repository's own Git directory.
 */
export function verifyMergeWrites(commonDir: string, writes: MergeWrites): void {
  realFolder(commonDir);
  if (writes.objects === true) {
    const objects = path.join(commonDir, 'objects');
    const store = found(objects);
    if (store === undefined) throw new GitMetadataError('missing', `${objects} is missing.`);
    folder(objects, store);
    // Each loose object goes in the fan-out folder its id's first two digits name, made there if
    // it is missing: every one that is there is checked, whichever the objects turn out to be. A
    // file past core.bigFileThreshold is streamed into a pack of its own instead.
    for (const name of entries(objects)) {
      if (!/^(?:[0-9a-f]{2}|pack)$/.test(name)) continue;
      const at = path.join(objects, name);
      const there = found(at);
      if (there !== undefined) folder(at, there);
    }
  }
  if (writes.checkout !== undefined) {
    const own = writes.checkout;
    const registrations = path.join(commonDir, 'worktrees');
    if (
      own !== commonDir &&
      (path.dirname(own) !== registrations || ['', '.', '..'].includes(path.basename(own)))
    ) {
      throw new TypeError(`${own} isn’t a checkout’s Git directory of ${commonDir}.`);
    }
    if (own !== commonDir) {
      const there = found(registrations);
      if (there === undefined)
        throw new GitMetadataError('missing', `${registrations} is missing.`);
      folder(registrations, there);
      realFolder(own);
    }
    // Its index and ORIG_HEAD, replaced whole by a rename; its HEAD's reflog, appended to.
    along(own, ['index'], false);
    along(own, ['ORIG_HEAD'], false);
    along(own, ['logs', 'HEAD'], true);
    const reftable = path.join(own, 'reftable');
    const tables = found(reftable);
    if (tables !== undefined) folder(reftable, tables);
  }
  if (writes.branch !== undefined) {
    branch(commonDir, writes.branch);
    const reftable = path.join(commonDir, 'reftable');
    const tables = found(reftable);
    if (tables !== undefined) folder(reftable, tables);
  }
}

/** `at` is a real folder of the user's, at its real path: no link anywhere along it. */
function realFolder(at: string): void {
  let real: string;
  try {
    real = realpathSync(at);
  } catch {
    throw new GitMetadataError('unreadable', `The Git directory ${at} can’t be read.`);
  }
  if (real !== at) {
    throw new GitMetadataError('symlinked', `The Git directory ${at} isn’t its real path.`);
  }
  const there = found(at);
  if (there === undefined) {
    throw new GitMetadataError('unreadable', `The Git directory ${at} can’t be read.`);
  }
  folder(at, there);
}

/** A branch's loose ref and reflog in the common directory, and `packed-refs` if it is there. */
function branch(commonDir: string, ref: string): void {
  const parts = ref.split('/');
  if (
    parts.length < 3 ||
    parts[0] !== 'refs' ||
    parts[1] !== 'heads' ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`${ref} isn’t a branch’s ref.`);
  }
  // Its loose ref, replaced whole by a rename; its reflog, appended to in place.
  along(commonDir, parts, false);
  along(commonDir, ['logs', ...parts], true);
  const packed = path.join(commonDir, 'packed-refs');
  const packedFound = found(packed);
  if (packedFound !== undefined) file(packed, packedFound, false);
}

function entries(at: string): string[] {
  try {
    return readdirSync(at);
  } catch {
    throw new GitMetadataError('unreadable', `${at} can’t be read.`);
  }
}

/**
 * Each folder from `root` down `parts` that is there, a real folder of the user's; the last part, a
 * file Git writes, a real file of the user's if it is there. Past a folder that isn't there yet,
 * Git makes the rest itself, inside the last one checked; past a file (a reftable repository's
 * `refs/heads` stub), Git writes nothing.
 */
function along(root: string, parts: readonly string[], appended: boolean): void {
  let at = root;
  for (const [index, part] of parts.entries()) {
    at = path.join(at, part);
    const there = found(at);
    if (there === undefined) return;
    if (index === parts.length - 1) file(at, there, appended);
    else if (!there.isSymbolicLink() && !there.isDirectory()) return;
    else folder(at, there);
  }
}

function found(at: string): Stats | undefined {
  try {
    return lstatSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GitMetadataError('unreadable', `${at} can’t be read.`);
  }
}

function owned(at: string, there: Stats): void {
  if (process.platform !== 'win32' && there.uid !== process.getuid?.()) {
    throw new GitMetadataError('unowned', `${at} is another user’s.`);
  }
}

function folder(at: string, there: Stats): void {
  if (there.isSymbolicLink()) {
    throw new GitMetadataError(
      'symlinked',
      `${at} is a symlink: Git’s metadata is written only in the repository’s own Git directory.`,
    );
  }
  if (!there.isDirectory()) throw new GitMetadataError('not-folder', `${at} isn’t a folder.`);
  owned(at, there);
}

function file(at: string, there: Stats, appended: boolean): void {
  if (there.isSymbolicLink()) {
    throw new GitMetadataError(
      'symlinked',
      `${at} is a symlink: Git’s metadata is written only in the repository’s own Git directory.`,
    );
  }
  if (!there.isFile()) throw new GitMetadataError('not-file', `${at} isn’t a file.`);
  if (appended && there.nlink !== 1) {
    throw new GitMetadataError('linked', `${at} has other names: Git would write to them too.`);
  }
  owned(at, there);
}
