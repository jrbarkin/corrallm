import { lstatSync, realpathSync } from 'node:fs';
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
  let real: string;
  try {
    real = realpathSync(commonDir);
  } catch {
    throw new GitMetadataError('unreadable', `The Git directory ${commonDir} can’t be read.`);
  }
  if (real !== commonDir) {
    throw new GitMetadataError('symlinked', `The Git directory ${commonDir} isn’t its real path.`);
  }
  const common = found(commonDir);
  if (common === undefined) {
    throw new GitMetadataError('unreadable', `The Git directory ${commonDir} can’t be read.`);
  }
  folder(commonDir, common);
  const parts = writes.branch.split('/');
  if (
    parts.length < 3 ||
    parts[0] !== 'refs' ||
    parts[1] !== 'heads' ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`${writes.branch} isn’t a branch’s ref.`);
  }
  // Its loose ref, replaced whole by a rename; its reflog, appended to in place.
  along(commonDir, parts, false);
  along(commonDir, ['logs', ...parts], true);
  const packed = path.join(commonDir, 'packed-refs');
  const packedFound = found(packed);
  if (packedFound !== undefined) file(packed, packedFound, false);
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
