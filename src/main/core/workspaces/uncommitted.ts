import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { BRANCH_LIMITS } from '../../../shared/api/branch';
import type { BranchFile } from '../../../shared/api/branch';
import { branchPath } from '../../../shared/model/branch-patch';
import { uncommittedDigest } from '../../../shared/model/branch-review';
import { MERGE_TIMEOUT_MS } from './git';
import type { GitCall, GitRunner } from './git';
import {
  filteredPaths,
  folded,
  hiddenEntries,
  rawChanges,
  REPLACEMENT,
  statusEntries,
} from './merge-checks';
import type { StatusEntry } from './merge-checks';
import { gitRefusal, refuse } from './merge-select';
import type { Selected } from './merge-select';

/*
 * An agent's uncommitted work, read over its real worktree (B9b Design §9 C2's digest and C6's
 * eligibility): every path whose file differs from its branch's tip, as `add -A` would store it,
 * and the digest a checkpoint is bound to. Read by `status --no-optional-locks --porcelain=v2
 * --no-renames` (no lock, nothing rewritten: a plain status refreshes the agent's index), each
 * file then hashed as `add` would store it (`hash-object` without `-w`, its filter blanked, so the
 * attributes' built-in conversions apply and no program runs) or, for a link, by the core over its
 * link text. Nothing is written.
 *
 * The digest is X1's `uncommittedDigest` over those entries, the tip first. It is the one
 * `treeDigest` gives a checkpoint's tree (a temporary index's `read-tree <tip>`, `add -A`,
 * `write-tree`), so the merge service can check that what it commits is what was reviewed. There is
 * none, and so no commit offered, when the review can't promise that: nothing uncommitted; a path
 * partly staged (its index-only version a checkpoint would lose) or unmerged; a submodule or nested
 * repository; a local file copied into the workspace (its copy record), or a copy record that
 * can't be read; a path a configured filter applies to; a name that isn't UTF-8; changes hidden
 * from status (skip-worktree, assume-unchanged, a sparse checkout); a file that isn't a regular
 * one or a link, or one under a link; an untracked file with another name (a hard link, which
 * Review changes doesn't read); more than 10,000 entries (counted, not listed) or more than 1 GiB
 * to hash; or anything Git couldn't read whole.
 */

/** An uncommitted path, as the review shows it and the digest takes it. */
export interface UncommittedFile {
  /** Its repository-relative path (a name that isn't UTF-8 shown lossy, `note: 'lossy-name'`). */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'type-changed' | 'untracked';
  /** Whether its index differs from the tip (a staged change), and from its file too. */
  staged: boolean;
  partlyStaged: boolean;
  /** Its mode at the tip, and as `add` would store its file (null: none). */
  mode: { old: string | null; new: string | null };
  /** The blob `add` would store for its file: null for a deletion, or where none was hashed. */
  oid: string | null;
  note?: BranchFile['note'];
}

/** Why an inventory has no digest. */
export type NoDigest =
  | 'clean'
  | 'incomplete'
  | 'partly-staged'
  | 'unmerged'
  | 'submodule'
  | 'copied'
  | 'copies-unknown'
  | 'filtered'
  | 'lossy-name'
  | 'hidden'
  | 'unreadable'
  | 'too-large';

export interface Uncommitted {
  /** The tip it is read against (the worktree's HEAD, on its branch). */
  tip: string;
  /** At most 10,000, sorted by their paths' bytes. */
  files: UncommittedFile[];
  /** How many tracked paths changed and untracked ones there are, all counted. */
  changed: number;
  untracked: number;
  partlyStaged: number;
  /** Whether every entry is listed (and Git read the worktree whole). */
  complete: boolean;
  digest: string | null;
  /** Why there is no digest, if there isn't. */
  why?: NoDigest;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** How much of a worktree's status is read: past it, the inventory is incomplete. */
const STATUS_BYTES = 64 * 1024 * 1024;
/** How much a worktree's index listing may print. */
const LISTING_BYTES = 64 * 1024 * 1024;
/** How many bytes of names one hash-object takes. */
const NAMES_BYTES = 128 * 1024;

/**
 * The uncommitted work in the worktree at `cwd` (an agent's verified checkout, on its branch,
 * whose tip is `tip`): its files, counts and digest. `drivers` are the filter drivers configured
 * there (blanked on every call); `copied`, what its copy record names (null: unknown). A conflict
 * if the worktree's HEAD isn't `tip` (its branch moved since it was read).
 */
export async function inventoryUncommitted(
  git: GitRunner,
  {
    cwd,
    tip,
    drivers,
    copied,
  }: { cwd: string; tip: string; drivers: readonly string[]; copied: readonly string[] | null },
): Promise<Selected<Uncommitted>> {
  if (!OID.test(tip)) throw new TypeError(`${tip} isn’t a commit’s object id.`);
  const call: Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs'> = {
    cwd,
    drivers,
    noReplaceObjects: true,
    timeoutMs: MERGE_TIMEOUT_MS,
  };
  const moved = refuse(
    'conflict',
    'moved-source',
    'The work changed since it was read: review it again.',
  );
  try {
    const head = async () =>
      (
        await git.run({ ...call, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], answers: [1] })
      ).stdout.trim();
    if ((await head()) !== tip) return { ok: false, refusal: moved };
    const settings = await git.run({
      ...call,
      args: [
        'config',
        '-z',
        '--type=bool',
        '--get-regexp',
        '^(core\\.sparsecheckout|index\\.sparse|core\\.filemode)$',
      ],
      answers: [1],
    });
    const setting = new Map(
      settings.stdout
        .split('\0')
        .filter((entry) => entry.includes('\n'))
        .map((entry) => {
          const newline = entry.indexOf('\n');
          return [entry.slice(0, newline).toLowerCase(), entry.slice(newline + 1)] as const;
        }),
    );
    const index = await git.run({
      ...call,
      maxBytes: LISTING_BYTES,
      args: ['ls-files', '-v', '-z'],
    });
    const hidden =
      hiddenEntries(index.stdout).length > 0 ||
      setting.get('core.sparsecheckout') === 'true' ||
      setting.get('index.sparse') === 'true';
    const status = await git.capped({
      ...call,
      cap: STATUS_BYTES,
      args: [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=dirty',
        '--no-renames',
      ],
    });
    if ((await head()) !== tip) return { ok: false, refusal: moved };
    const read = entriesOf(statusEntries(status.stdout, status.cut));
    const whole = !status.cut && status.stderr.trim() === '' && read.parsed;
    const all = [...read.files.values()].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    );
    const complete = whole && all.length <= BRANCH_LIMITS.inventoryEntries;
    const files = all.slice(0, BRANCH_LIMITS.inventoryEntries);
    const counts = {
      changed: all.filter((file) => file.status !== 'untracked').length,
      untracked: all.filter((file) => file.status === 'untracked').length,
      partlyStaged: all.filter((file) => file.partlyStaged).length,
    };
    const without = (why: NoDigest): Selected<Uncommitted> => ({
      ok: true,
      value: { tip, files, ...counts, complete, digest: null, why },
    });

    // What the files are, as the file system has them now: links by their text, never followed.
    const fileMode = setting.get('core.filemode') !== 'false';
    const objectFormat = tip.length === 64 ? 'sha256' : 'sha1';
    const folders = new Map<string, boolean>();
    const regular: UncommittedFile[] = [];
    let bytes = 0;
    let why: NoDigest | undefined;
    for (const file of files) {
      if (file.note !== undefined || file.status === 'deleted') continue;
      if (!underFolders(cwd, file.path, folders)) {
        file.note = 'unreadable';
        continue;
      }
      let found: Stats;
      try {
        found = lstatSync(path.join(cwd, file.path));
      } catch {
        file.note = 'unreadable';
        continue;
      }
      if (found.isSymbolicLink()) {
        file.note = 'symlink';
        if (file.mode.new !== null && file.mode.new !== '120000') file.note = 'unreadable';
        else {
          file.mode.new = '120000';
          file.oid = blobOf(
            readlinkSync(path.join(cwd, file.path), { encoding: 'buffer' }),
            objectFormat,
          );
        }
      } else if (found.isFile()) {
        if (file.status === 'untracked' && found.nlink !== 1) {
          // Review changes reads an untracked file itself, only one with no other name (§9 C2):
          // what it can't show, a checkpoint doesn't commit.
          file.note = 'unreadable';
          continue;
        }
        if (file.status === 'untracked') {
          file.mode.new = fileMode && (found.mode & 0o100) !== 0 ? '100755' : '100644';
        } else if (file.mode.new !== '100644' && file.mode.new !== '100755') {
          file.note = 'unreadable';
          continue;
        }
        bytes += found.size;
        if (bytes > BRANCH_LIMITS.hashBytes) {
          file.note = 'too-large';
          why ??= 'too-large';
          continue;
        }
        regular.push(file);
      } else file.note = 'unreadable';
    }

    if (!whole) return without(read.unmerged ? 'unmerged' : 'unreadable');
    if (all.length === 0) return without('clean');
    if (!complete) return without('incomplete');
    if (read.unmerged) return without('unmerged');
    if (counts.partlyStaged > 0) return without('partly-staged');
    if (files.some((file) => file.note === 'gitlink' || file.note === 'nested-repository')) {
      return without('submodule');
    }
    if (files.some((file) => file.note === 'lossy-name')) return without('lossy-name');
    if (hidden) return without('hidden');
    if (copied === null) return without('copies-unknown');
    const copies = new Set(copied.map((one) => folded(one, true)));
    if (files.some((file) => copies.has(folded(file.path, true)))) return without('copied');
    if (why !== undefined) return without(why);
    if (files.some((file) => file.note === 'unreadable')) return without('unreadable');
    const present = files.filter((file) => file.status !== 'deleted').map((file) => file.path);
    if ((await filteredPaths(git, { cwd, drivers }, present)).length > 0) {
      return without('filtered');
    }

    // Each regular file hashed as `add` would store it, its filter blanked: nothing written.
    for (const batch of batches(regular)) {
      const { stdout } = await git.run({
        ...call,
        args: ['hash-object', '--', ...batch.map((file) => file.path)],
      });
      const oids = stdout.split('\n').filter((line) => line !== '');
      if (oids.length !== batch.length || !oids.every((oid) => OID.test(oid))) {
        return without('unreadable');
      }
      batch.forEach((file, i) => {
        file.oid = oids[i] ?? null;
      });
    }
    if ((await head()) !== tip) return { ok: false, refusal: moved };
    const zero = '0'.repeat(tip.length);
    let digest: string;
    try {
      digest = await uncommittedDigest(
        tip,
        files.map((file) =>
          file.status === 'deleted'
            ? { path: Buffer.from(file.path), mode: '000000', oid: zero }
            : { path: Buffer.from(file.path), mode: file.mode.new ?? '', oid: file.oid ?? '' },
        ),
      );
    } catch {
      // An entry the canonical manifest can't take unambiguously: no digest, rather than a guess.
      return without('unreadable');
    }
    return { ok: true, value: { tip, files, ...counts, complete, digest } };
  } catch (error) {
    return { ok: false, refusal: gitRefusal(error, 'read the worktree') };
  }
}

/** The uncommitted files status names, by path, and whether it named only what it says. */
function entriesOf(entries: readonly StatusEntry[]): {
  files: Map<string, UncommittedFile>;
  unmerged: boolean;
  parsed: boolean;
} {
  const files = new Map<string, UncommittedFile>();
  let unmerged = false;
  let parsed = true;
  for (const entry of entries) {
    if (entry.kind === '?') {
      const tracked = files.get(entry.path);
      if (tracked !== undefined) {
        // Removed from the index, still on disk: its index differs from both.
        tracked.partlyStaged = true;
        continue;
      }
      // A folder status names whole holds a repository of its own: never committed.
      const nested = entry.path.endsWith('/');
      files.set(entry.path, {
        ...shownPath(entry.path),
        status: 'untracked',
        staged: false,
        partlyStaged: false,
        mode: { old: null, new: null },
        oid: null,
        ...(nested ? { note: 'nested-repository' as const } : {}),
      });
    } else if (entry.kind === '1' || entry.kind === 'u') {
      const [x = '.', y = '.'] = entry.xy;
      const [head = '000000', , worktree = '000000'] =
        entry.kind === 'u' ? [entry.modes[0], '', entry.modes[3]] : entry.modes;
      if (entry.kind === 'u') unmerged = true;
      const deleted = worktree === '000000';
      const gitlink = entry.sub.startsWith('S') || entry.modes.some((mode) => mode === '160000');
      const status: UncommittedFile['status'] =
        x === 'A' || (y === 'A' && x === '.')
          ? 'added'
          : deleted
            ? 'deleted'
            : x === 'T' || y === 'T'
              ? 'type-changed'
              : 'modified';
      const shown = shownPath(entry.path);
      files.set(entry.path, {
        ...shown,
        status,
        staged: x !== '.',
        partlyStaged: x !== '.' && y !== '.',
        mode: { old: head === '000000' ? null : head, new: deleted ? null : worktree },
        oid: null,
        ...(gitlink ? { note: 'gitlink' as const } : {}),
      });
    } else parsed = false;
  }
  return { files, unmerged, parsed };
}

/** A path as the review shows it: lossy (and shortened) where it isn't UTF-8 or is too long. */
export function shownPath(at: string): Pick<UncommittedFile, 'path' | 'note'> {
  if (at.includes(REPLACEMENT))
    return { path: branchPath(Buffer.from(at)).path, note: 'lossy-name' };
  return branchPath(Buffer.from(at));
}

/**
 * Whether each folder `relative` is in, below `root`, is a real folder (no link): a file read
 * through a link isn't the worktree's. Folders seen are remembered in `seen`.
 */
function underFolders(root: string, relative: string, seen: Map<string, boolean>): boolean {
  const parts = relative.split('/').slice(0, -1);
  let at = root;
  for (const part of parts) {
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

/** The id of a blob holding `bytes`, as Git stores it in a repository of `format`. */
function blobOf(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

/** Files split into lists whose names take at most NAMES_BYTES each, for one call each. */
function batches(files: readonly UncommittedFile[]): UncommittedFile[][] {
  const found: UncommittedFile[][] = [];
  let current: UncommittedFile[] = [];
  let size = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.path) + 1;
    if (current.length > 0 && size + bytes > NAMES_BYTES) {
      found.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += bytes;
  }
  if (current.length > 0) found.push(current);
  return found;
}

/**
 * The digest of what a checkpoint's tree (`tree`, made from `tip`) commits: the changes from the
 * tip, as `uncommittedDigest` takes them. The merge service compares it with the digest the caller
 * reviewed. None where it can't be one: nothing changed, a submodule, a name that isn't UTF-8, too
 * many entries.
 */
export async function treeDigest(
  git: GitRunner,
  { cwd, drivers }: { cwd: string; drivers: readonly string[] },
  { tip, tree }: { tip: string; tree: string },
): Promise<string | null> {
  if (!OID.test(tip) || !OID.test(tree)) throw new TypeError('A digest is of object ids.');
  const { stdout } = await git.run({
    cwd,
    drivers,
    noReplaceObjects: true,
    timeoutMs: MERGE_TIMEOUT_MS,
    maxBytes: LISTING_BYTES,
    args: ['diff-tree', '-r', '-z', '--no-renames', '--ignore-submodules=none', tip, tree],
  });
  const changes = rawChanges(stdout);
  if (
    changes === undefined ||
    changes.length === 0 ||
    changes.length > BRANCH_LIMITS.inventoryEntries ||
    changes.some(
      (change) => change.lossy || change.oldMode === '160000' || change.newMode === '160000',
    )
  ) {
    return null;
  }
  const zero = '0'.repeat(tip.length);
  return uncommittedDigest(
    tip,
    changes.map((change) =>
      change.status === 'deleted'
        ? { path: Buffer.from(change.path), mode: '000000', oid: zero }
        : { path: Buffer.from(change.path), mode: change.newMode, oid: change.newOid },
    ),
  );
}
