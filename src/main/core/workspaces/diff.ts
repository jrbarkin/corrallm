import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { BRANCH_LIMITS, BranchLimit, BranchRef } from '../../../shared/api/branch';
import type { BranchDiffOutput, BranchFile } from '../../../shared/api/branch';
import type { OpResult } from '../../../shared/api/errors';
import type { AgentId, WorktreeId } from '../../../shared/api/ids';
import { MAX_PAGE_BYTES } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { branchDiffPage, untrackedFilePatch } from '../../../shared/model/branch-patch';
import type { BranchDiffHeader } from '../../../shared/model/branch-patch';
import { branchPosition } from '../../../shared/model/branch-review';
import type { TrustedPath } from '../host';
import { O_NOFOLLOW } from './copy';
import { GitError, MERGE_TIMEOUT_MS } from './git';
import type { CappedOutput, GitCall, GitRunner } from './git';
import { sharing } from './list';
import type { Viewer, WorktreeListing } from './list';
import { statusEntries, WORKTREE_READ_CONFIG } from './merge-checks';
import { findDestination, gitRefusal, selectSource } from './merge-select';
import type { DestinationSeen, MergeRefusal } from './merge-select';
import type { WorkspaceStore } from './store';
import { inventoryUncommitted, shownPath } from './uncommitted';

/*
 * The diff service (B9b Design §4, §9 C2, C3): an agent's branch for review, one bounded page at a
 * time, for `branch.diff` to answer (X2 registers it over `readBranchDiff`). It reads only: it
 * makes, repairs and populates no worktree, starts no session, runs no setup, writes nothing in
 * any checkout or Git directory, and runs no program a repository configures.
 *
 * - **What it is of** is found again on every page (C3): the agent's active binding's workspace,
 *   its checkout verified, its generated branch and that branch's tip now (`selectSource`); the
 *   recorded base commit, which must still be in the repository; the branch your picked checkout
 *   is on now (`findDestination`'s `seen`, shown and never merged into here); and, for `shared`,
 *   the members of the same tree the caller's own `worktree.list` names (`sharing`), never one it
 *   doesn't reach. A pending Switch still reviews the active tree; one whose checkout is off its
 *   branch is reviewed without its uncommitted work (`onBranch` false, that section incomplete).
 * - **Committed work** is the tree difference from the recorded base to the tip: `diff -M`, its
 *   pairing and order pinned (`-l1000 -O/dev/null`) whatever the repository's configuration says,
 *   each patch read for the entry itself (both of a rename's names) through `GitRunner.patch`, so
 *   safeGitDiffArgs, literal paths and no lock, capped. A file Git calls binary has no patch; a
 *   submodule, a name that isn't UTF-8 (or is too long to show whole) has none either; one Git
 *   couldn't read (a partial clone's missing blob, never fetched) is marked unreadable.
 * - **Uncommitted work** is C3's inventory (`inventoryUncommitted`), its digest the one a
 *   checkpoint is bound to. A tracked file's patch is Git's, from the tip to the file as it is;
 *   an untracked file is read by the core: under real folders only, opened without following a
 *   link, a regular file with one name, at most 1 MiB, binary by a NUL; a link by its text. A
 *   file with another name, tracked or not, is shown unreadable with no patch (the inventory's
 *   note), and then no commit is offered.
 * - **Paging retains nothing** (C2's revalidated continuation). Each page reads everything again;
 *   its cursor binds the tip, the digest and the review's state (a SHA-256 of the workspace, its
 *   base, its tip, and the worktree as Git's status and the file system have it, read before and
 *   after the page: what its entries are read from), so a continuation is refused (`conflict`)
 *   wherever the work changed, the digest null or not. A change while a page is read is never
 *   spliced in: a first page is read again (twice at most), a later one refused.
 * - **Every Git call** is the runner's, its filter drivers blanked, replace refs ignored; every path
 *   it names is after `--`, literal. Nothing Git couldn't read whole is reported as no changes.
 */

/** What the diff service reads with. */
export interface BranchDiffDeps {
  git: GitRunner;
  workspaces: WorkspaceStore;
  /** The canvas's picked project folder, as the core keeps it (none: not chosen, or not restored). */
  projectRoot: (canvas: CanvasId) => TrustedPath | undefined;
  /** What setup copied into a workspace (`WorkspaceSetups.copied`): none if unknown. */
  copied: (workspace: string) => readonly string[] | undefined;
  /** The authorized listing (worktree.list's selector), as `viewer` sees the canvas. */
  list: (
    canvas: CanvasId,
    viewer: Viewer,
    agent?: string,
    document?: CanvasDocument,
  ) => Promise<WorktreeListing>;
  /** What sentences call the agent. */
  nameOf: (canvas: CanvasId, agent: string) => string | undefined;
}

/** A page of an agent's branch, as `branch.diff` asks for it. */
export interface BranchDiffRequest {
  canvas: CanvasId;
  /** Reached by the caller (core.call checks it, as for every op naming an agent). */
  agent: string;
  /** The previous page's `next`, if this isn't the first. */
  after?: string | undefined;
  /** 1 to 200. */
  limit: number;
  /** Whom `shared` is for: you, or a token by the agents its `worktree.list` reaches. */
  viewer: Viewer;
  /** A token's open canvas's document, as reach was checked on (else the canvas's now). */
  document?: CanvasDocument | undefined;
}

/** How a listing and a status are read: past these, they are incomplete. */
const LISTING_BYTES = 64 * 1024 * 1024;
/** How many times a first page is read when the work changes as it is read. */
const ATTEMPTS = 3;
/** How every patch is printed: no colour, every path from the top, a/ and b/ as Git's default. */
const PRINTED = ['--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];
/**
 * How committed work is paired and ordered: renames found as `diff -M` finds them, with the
 * default rename limit and no order file, so the repository's diff.renameLimit and diff.orderFile
 * never change what a page holds.
 */
const PAIRED = ['-M', '-l1000', '-O/dev/null'];
/** A worktree's status, as C3's inventory reads it: no lock, nothing rewritten. */
const STATUS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=dirty',
  '--no-renames',
];
/** The modes a review shows (others, Git's legacy ones, aren't shown). */
const MODES = ['100644', '100755', '120000', '160000', '040000'] as const;
type Shown = (typeof MODES)[number];
/** Notes under which an entry has no patch. */
const NO_PATCH = new Set(['gitlink', 'nested-repository', 'unreadable', 'lossy-name']);
const STATUSES: Readonly<Record<string, BranchFile['status']>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};
const RAW =
  /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([AMDTRC])\d*$/;

/** An entry of the review, and how its patch is read when its page holds it. */
interface Entry {
  file: BranchFile;
  read:
    | { kind: 'committed'; paths: readonly string[] }
    | { kind: 'tracked'; path: string }
    | { kind: 'untracked'; path: string; executable: boolean }
    | { kind: 'none' };
}

/** The work changed while a page was read. */
const CHANGED = Symbol('changed');

/**
 * A page of the agent's branch for review: its header (what it is of, as read now) and the
 * entries from `after`'s position, at most `limit` and 60 KiB of serialized result; or why not,
 * as the operation's error.
 */
export async function readBranchDiff(
  deps: BranchDiffDeps,
  request: BranchDiffRequest,
): Promise<OpResult<BranchDiffOutput>> {
  if (!BranchLimit.safeParse(request.limit).success) {
    return failed('invalid', 'Invalid review page: review the changes again.');
  }
  const name = deps.nameOf(request.canvas, request.agent) ?? request.agent;
  for (let attempt = 1; ; attempt++) {
    const read = await readPage(deps, request, name);
    if (read !== CHANGED) return read;
    if (request.after !== undefined) return changedSince(name);
    if (attempt >= ATTEMPTS) {
      return failed(
        'conflict',
        `${name}’s work kept changing as it was read: review it again once it settles.`,
      );
    }
  }
}

async function readPage(
  deps: BranchDiffDeps,
  { canvas, agent, after, limit, viewer, document }: BranchDiffRequest,
  name: string,
): Promise<OpResult<BranchDiffOutput> | typeof CHANGED> {
  const { git } = deps;
  const selected = await selectSource(
    { git, workspaces: deps.workspaces },
    { canvas, agent, name },
  );
  if (!selected.ok) return refused(selected.refusal);
  const source = selected.value;
  const { workspace, tip } = source;
  const base = workspace.baseOid;
  const call: Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs' | 'config'> = {
    cwd: source.cwd,
    drivers: source.drivers,
    noReplaceObjects: true,
    timeoutMs: MERGE_TIMEOUT_MS,
    config: WORKTREE_READ_CONFIG,
  };
  try {
    const kept = await git.run({
      ...call,
      args: ['rev-parse', '--verify', '--quiet', `${base}^{commit}`],
      answers: [1, 128],
    });
    if (base.length !== tip.length || kept.stdout.trim() !== base) {
      return failed(
        'unavailable',
        `${name}’s worktree was made from a commit your repository no longer has, so its changes can’t be listed.`,
      );
    }
    const picked = deps.projectRoot(canvas);
    const into = shownInto(
      picked === undefined
        ? { ref: null, oid: null }
        : (await findDestination(git, { picked, repository: source.repository })).seen,
      tip.length,
    );
    const listing = await deps.list(canvas, viewer, undefined, document);
    const shared = sharing(listing, agent).map((item) => item.agent as AgentId);
    const committed = await listCommitted(git, call, { base, tip });
    if (committed === undefined) {
      return failed(
        'unavailable',
        `Git couldn’t list ${name}’s committed work just now: try again.`,
      );
    }

    // The uncommitted work, read between two readings of the worktree's state.
    let before: string | undefined;
    let uncommitted: BranchDiffHeader['uncommitted'] = {
      changed: 0,
      untracked: 0,
      partlyStaged: 0,
      complete: false,
      digest: null,
    };
    const entries: Entry[] = [...committed.entries];
    if (source.onBranch) {
      before = await worktreeState(git, call);
      const inventory = await inventoryUncommitted(git, {
        cwd: source.cwd,
        tip,
        drivers: source.drivers,
        copied: deps.copied(workspace.id) ?? null,
      });
      if (!inventory.ok) {
        return inventory.refusal.reason === 'moved-source' ? CHANGED : refused(inventory.refusal);
      }
      const { changed, untracked, partlyStaged, complete, digest } = inventory.value;
      uncommitted = { changed, untracked, partlyStaged, complete, digest };
      for (const file of inventory.value.files) {
        const shown: BranchFile = {
          section: 'uncommitted',
          path: file.path,
          status: file.status,
          ...modes(file.mode.old, file.mode.new),
          staged: file.staged,
          ...(file.note === undefined ? {} : { note: file.note }),
        };
        entries.push({
          file: shown,
          read:
            file.note !== undefined && NO_PATCH.has(file.note)
              ? { kind: 'none' }
              : file.status === 'untracked'
                ? { kind: 'untracked', path: file.path, executable: file.mode.new === '100755' }
                : { kind: 'tracked', path: file.path },
        });
      }
    }
    const state = createHash('sha256')
      .update(`corrallm review 1\0${workspace.id}\0${base}\0${tip}\0${before ?? 'off-branch'}`)
      .digest('hex');
    const header: BranchDiffHeader = {
      agent: agent as AgentId,
      workspace: workspace.id as WorktreeId,
      shared,
      source: { ref: source.ref, oid: tip, onBranch: source.onBranch },
      base: { ref: boundedRef(workspace.baseRef), oid: base },
      into,
      committed: { files: committed.total, complete: committed.complete },
      uncommitted,
    };
    const position = branchPosition(after, { tip, digest: uncommitted.digest, state });
    if (!position.ok) {
      return position.error.code === 'conflict' ? changedSince(name) : position;
    }

    // Patches only for what this page can hold: past 60 KiB of them, nothing more fits.
    const files = entries.map((entry) => entry.file);
    let used = Buffer.byteLength(JSON.stringify(header));
    let read = 0;
    for (let at = position.value; at < Math.min(entries.length, position.value + limit); at++) {
      const entry = entries[at];
      if (entry === undefined) break;
      const full = await withPatch(git, call, entry, { base, tip, cwd: source.cwd });
      files[at] = full;
      read++;
      used += Buffer.byteLength(JSON.stringify(full));
      if (used >= MAX_PAGE_BYTES) break;
    }
    if (before !== undefined && (await worktreeState(git, call)) !== before) return CHANGED;
    return branchDiffPage(header, files, { after, limit: Math.max(1, read), state });
  } catch (error) {
    return refused(gitRefusal(error, `read ${name}’s worktree`));
  }
}

/** The committed entries from `base` to `tip`: at most 10,000 listed, every one counted. */
async function listCommitted(
  git: GitRunner,
  call: Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs' | 'config'>,
  { base, tip }: { base: string; tip: string },
): Promise<{ entries: Entry[]; total: number; complete: boolean } | undefined> {
  const read = await git.patch({
    ...call,
    command: 'diff',
    cap: LISTING_BYTES,
    args: ['--raw', '-z', '--no-abbrev', '--no-color', '--no-relative', ...PAIRED, base, tip],
  });
  const fields = read.stdout.split('\0');
  // What follows the last NUL is a whole field only if nothing was cut (then it is empty).
  fields.pop();
  const entries: Entry[] = [];
  let total = 0;
  for (let i = 0; i < fields.length;) {
    const head = RAW.exec(fields[i] ?? '');
    if (head === null) return undefined;
    const [, oldMode = '', newMode = '', , , letter = ''] = head;
    const renamed = letter === 'R' || letter === 'C';
    const names = fields.slice(i + 1, i + (renamed ? 3 : 2));
    if (names.length < (renamed ? 2 : 1)) {
      // A record the cap cut short.
      if (read.cut) break;
      return undefined;
    }
    i += renamed ? 3 : 2;
    total++;
    if (entries.length >= BRANCH_LIMITS.inventoryEntries) continue;
    const [from = '', to = ''] = renamed ? names : [names[0] ?? '', names[0] ?? ''];
    const shownTo = shownPath(to);
    const shownFrom = renamed ? shownPath(from) : undefined;
    const lossy = shownTo.note === 'lossy-name' || shownFrom?.note === 'lossy-name';
    const linked = oldMode === '160000' || newMode === '160000';
    const symlink = oldMode === '120000' || newMode === '120000';
    const status = STATUSES[letter];
    if (status === undefined) return undefined;
    entries.push({
      file: {
        section: 'committed',
        path: shownTo.path,
        ...(shownFrom === undefined ? {} : { oldPath: shownFrom.path }),
        status,
        ...modes(oldMode, newMode),
        ...(lossy
          ? { note: 'lossy-name' as const }
          : linked
            ? { note: 'gitlink' as const }
            : symlink
              ? { note: 'symlink' as const }
              : {}),
      },
      read:
        lossy || linked
          ? { kind: 'none' }
          : { kind: 'committed', paths: renamed ? [from, to] : [to] },
    });
  }
  return {
    entries,
    total,
    complete: !read.cut && total <= BRANCH_LIMITS.inventoryEntries,
  };
}

/** An entry with its patch, as its page shows it. */
async function withPatch(
  git: GitRunner,
  call: Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs' | 'config'>,
  { file, read }: Entry,
  { base, tip, cwd }: { base: string; tip: string; cwd: string },
): Promise<BranchFile> {
  if (read.kind === 'none') return file;
  if (read.kind === 'untracked') return readUntracked(cwd, file, read);
  let output: CappedOutput;
  try {
    output = await git.patch({
      ...call,
      command: 'diff',
      cap: MAX_PAGE_BYTES,
      args:
        read.kind === 'committed'
          ? [...PRINTED, ...PAIRED, base, tip, '--', ...read.paths]
          : [...PRINTED, '--no-renames', tip, '--', read.path],
    });
  } catch (error) {
    // Git couldn't read it (a missing object, never fetched): listed, never left out.
    if (error instanceof GitError && error.fault === 'failed') {
      return { ...file, note: 'unreadable' };
    }
    throw error;
  }
  // A content line starts with a space, + or -: a line starting otherwise is Git's own.
  if (/^Binary files .* differ$/m.test(output.stdout)) return { ...file, binary: true };
  if (output.stdout === '' && read.kind === 'committed') return { ...file, note: 'unreadable' };
  return { ...file, patch: output.stdout, ...(output.cut ? { cut: true as const } : {}) };
}

/**
 * An untracked file's patch, from its bytes as the core reads them: under real folders only,
 * opened without following a link, a regular file with one name (the one status listed), at most
 * 1 MiB; a link by its text. Anything else is unreadable, with no patch.
 */
function readUntracked(
  cwd: string,
  file: BranchFile,
  { path: relative, executable }: { path: string; executable: boolean },
): BranchFile {
  const unreadable: BranchFile = { ...file, note: 'unreadable' };
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return unreadable;
  if (!realFolders(cwd, parts, new Map())) return unreadable;
  const at = path.join(cwd, ...parts);
  let found: Stats;
  try {
    found = lstatSync(at);
    if (found.isSymbolicLink()) {
      const text = readlinkSync(at, { encoding: 'buffer' });
      return { ...file, note: 'symlink', ...untrackedFilePatch(relative, text, { symlink: true }) };
    }
  } catch {
    return unreadable;
  }
  if (!found.isFile() || found.nlink !== 1) return unreadable;
  let fd: number;
  try {
    fd = openSync(at, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW);
  } catch {
    return unreadable;
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== found.dev ||
      opened.ino !== found.ino
    ) {
      return unreadable;
    }
    // One byte past the bound says there is more.
    const bytes = Buffer.alloc(BRANCH_LIMITS.untrackedBytes + 1);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { ...file, ...untrackedFilePatch(relative, bytes.subarray(0, read), { executable }) };
  } catch {
    return unreadable;
  } finally {
    closeSync(fd);
  }
}

/**
 * The worktree's state, as a page's entries are read from it: its HEAD, its status (as the
 * inventory reads it, index object ids included) and each path status lists (10,000 at most, as
 * listed), by what the file system says of it without following a link: its kind, mode, size,
 * modification and change times in nanoseconds, inode, device and links. A file written, even back
 * to the same bytes, changes its change time, so the same state before and after a page means
 * nothing it read changed meanwhile.
 */
async function worktreeState(
  git: GitRunner,
  call: Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs' | 'config'>,
): Promise<string> {
  const head = await git.run({
    ...call,
    args: ['rev-parse', '--verify', '--quiet', 'HEAD'],
    answers: [1],
  });
  const branch = await git.run({
    ...call,
    args: ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'],
    answers: [1],
  });
  const status = await git.capped({ ...call, cap: LISTING_BYTES, args: STATUS });
  const hash = createHash('sha256')
    .update('corrallm worktree 1\0')
    .update(`${head.stdout}\0${branch.stdout}\0${String(status.cut)}\0`)
    .update(status.stdout)
    .update('\0')
    .update(status.stderr)
    .update('\0');
  const paths = [...new Set(statusEntries(status.stdout, status.cut).map((entry) => entry.path))]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .slice(0, BRANCH_LIMITS.inventoryEntries);
  const folders = new Map<string, boolean>();
  for (const at of paths) hash.update(`${at}\0${statOf(call.cwd, at, folders)}\0`);
  return hash.digest('hex');
}

/** What the file system says of a path below `cwd`, never through a link. */
function statOf(cwd: string, relative: string, folders: Map<string, boolean>): string {
  const parts = relative.replace(/\/$/, '').split('/');
  if (!realFolders(cwd, parts, folders)) return 'beyond a link';
  try {
    const found = lstatSync(path.join(cwd, ...parts), { bigint: true });
    const kind = found.isSymbolicLink()
      ? 'l'
      : found.isFile()
        ? 'f'
        : found.isDirectory()
          ? 'd'
          : 'o';
    return [
      kind,
      found.mode,
      found.size,
      found.mtimeNs,
      found.ctimeNs,
      found.ino,
      found.dev,
      found.nlink,
    ].join(' ');
  } catch {
    return 'none';
  }
}

/** Whether each folder `parts` names below `root` (its last part aside) is a real one, no link. */
function realFolders(root: string, parts: readonly string[], seen: Map<string, boolean>): boolean {
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    let real = seen.get(at);
    if (real === undefined) {
      try {
        const found = lstatSync(at);
        real = found.isDirectory() && !found.isSymbolicLink();
      } catch {
        real = false;
      }
      seen.set(at, real);
    }
    if (!real) return false;
  }
  return true;
}

/** An entry's modes, as the review shows them (none for a mode it doesn't). */
function modes(old: string | null, now: string | null): Pick<BranchFile, 'mode'> {
  const from = shownMode(old);
  const to = shownMode(now);
  if (from === undefined || to === undefined) return {};
  return { mode: { old: from, new: to } };
}

/** A mode as the review shows it: none for none, undefined for one it doesn't show. */
function shownMode(mode: string | null): Shown | null | undefined {
  if (mode === null || mode === '000000') return null;
  return MODES.find((one) => one === mode);
}

/** A ref within the review's bound, else none: a longer one is never shown cut. */
function boundedRef(ref: string | null): string | null {
  return ref !== null && BranchRef.safeParse(ref).success ? ref : null;
}

/** Your checkout's branch and commit as seen: unread (both none) where they can't be shown. */
function shownInto(seen: DestinationSeen, length: number): BranchDiffHeader['into'] {
  const ref = boundedRef(seen.ref);
  if (seen.ref !== null && ref === null) return { ref: null, oid: null };
  return { ref, oid: seen.oid !== null && seen.oid.length === length ? seen.oid : null };
}

function failed(code: 'invalid' | 'conflict' | 'unavailable', sentence: string): OpResult<never> {
  return { ok: false, error: { code, sentence } };
}

function refused(refusal: MergeRefusal): OpResult<never> {
  return { ok: false, error: { code: refusal.code, sentence: refusal.sentence } };
}

function changedSince(name: string): OpResult<never> {
  return failed('conflict', `${name}’s work changed since you looked: review it again.`);
}
