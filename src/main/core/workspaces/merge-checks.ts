import { lstatSync } from 'node:fs';
import path from 'node:path';

import { branchPathSentence } from '../../../shared/model/branch-patch';
import { GitError, MERGE_TIMEOUT_MS } from './git';
import type { GitCall, GitRunner } from './git';
import { gitRefusal, refuse, shown } from './merge-select';
import type { MergeDestination, MergeRefusal, Selected } from './merge-select';
import { verifyMergeWrites } from './metadata';

/*
 * What is checked before a merge writes anything (B9b Design §9 C4, C9, C11; §9.3 steps 2, 4 to
 * 7), each read in your picked checkout, by the core, with every program a repository can make
 * Git run disabled (the runner's options, its filter drivers blanked) and replace refs ignored.
 * Each answers a refusal (the operation's code and a sentence naming at most five
 * repository-relative paths) or nothing; none writes, but `restoreOrigHead`, the merge service's
 * putting back of ORIG_HEAD.
 *
 * - **Clean** (`checkClean`): ORIG_HEAD a plain ref or none; no operation in progress in the
 *   checkout's own Git directory, no `index.lock`, and no lock on a ref the install updates (HEAD,
 *   ORIG_HEAD, the branch, packed refs or reftable's); merging's Git (2.39 or later); not shallow,
 *   no grafts; no sparse checkout, sparse or split index; `status --no-optional-locks` (which takes
 *   no lock and rewrites nothing: a plain status refreshes your index) listing nothing, ignored
 *   files aside; no skip-worktree or assume-unchanged entry, which hide changes from status. A file
 *   your filter changed as it checked it out reads as changed here, its filter blanked: refused,
 *   suggesting `git status`, which refreshes it with your filters.
 * - **What comes in** (`incomingChanges`, the merge's `diff-tree` from your branch's commit,
 *   submodule changes never hidden by configuration): nothing into corrallm's worktrees folder
 *   (`checkProtected`); no submodule change (`checkGitlinks`); no file a configured filter applies
 *   to, as `check-attr` reads it in your checkout, and no changed `.gitattributes` while any filter
 *   is configured (`checkFiltered`: §8's answer, refused naming the files, with the
 *   `git merge --no-ff` to run yourself); every object it writes present, never fetched
 *   (`checkObjects`); and, best effort, no ignored file where it writes (`checkIgnored`: Git's own
 *   `--no-overwrite-ignore` at the install is the guarantee).
 * - **ORIG_HEAD** (`readOrigHead`, `checkOrigHead`, `restoreOrigHead`): read as it is, refused
 *   unless it is a plain ref or none, and put back after a refused fast-forward with
 *   `update-ref --no-deref`, only if it is still what Git wrote, its metadata verified around it.
 */

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** What the runner reads in a name that isn't UTF-8: a name holding it is lossy. */
export const REPLACEMENT = String.fromCodePoint(0xfffd);
/** How much a listing of your checkout (its status, its index, a merge's changes) may print. */
const LISTING_BYTES = 64 * 1024 * 1024;
/** How much the ignored-file pre-flight reads before it is skipped. */
const IGNORED_BYTES = 4 * 1024 * 1024;
/** How many bytes of names one call takes, well within every platform's argument limit. */
const NAMES_BYTES = 128 * 1024;

/** Read worktree contents with full stat checks and a fixed, empty ordering input. */
export const WORKTREE_READ_CONFIG = [
  'core.checkStat=default',
  'core.trustctime=true',
  'core.ignoreStat=false',
  'diff.orderFile=/dev/null',
] as const;

/** What a refusal adds after naming filtered or submodule files: the merge to run yourself. */
function yourself(branch: string): string {
  return ` Merge it yourself in your checkout, where your repository’s programs run as they always do: git merge --no-ff ${shown(branch)}`;
}

/** A call in the destination: its filter drivers blanked, replace refs ignored. */
function there(
  destination: MergeDestination,
): Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'timeoutMs' | 'config'> {
  return {
    cwd: destination.root,
    drivers: destination.drivers,
    noReplaceObjects: true,
    timeoutMs: MERGE_TIMEOUT_MS,
    config: WORKTREE_READ_CONFIG,
  };
}

/**
 * Whether anything is at `at` (a file, folder or link); one that can't be read counts. Nothing is
 * below a file (a reftable repository's `refs/heads` stub, say).
 */
function present(at: string): boolean {
  try {
    lstatSync(at);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** The operations Git leaves state for in a checkout's own Git directory while they go on. */
const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase (or git am)'],
  ['BISECT_LOG', 'a bisect'],
  ['sequencer', 'a cherry-pick or revert'],
];

/** An entry of `status --porcelain=v2 -z`. */
export interface StatusEntry {
  /** Ordinary, renamed or copied, unmerged, untracked or ignored. */
  kind: '1' | '2' | 'u' | '?' | '!';
  /** XY: the index's and the file's changes ('.' for none); '??' and '!!' for the others. */
  xy: string;
  /** The submodule field (`N...` for none). */
  sub: string;
  /** The modes: HEAD's, the index's, the file's (for 'u', stage 1's, 2's, 3's and the file's). */
  modes: string[];
  path: string;
  /** A renamed or copied entry's original path. */
  from?: string;
}

/** The entries `status --porcelain=v2 -z` printed; a last one cut short is left out. */
export function statusEntries(stdout: string, cut = false): StatusEntry[] {
  const fields = stdout.split('\0');
  // What follows the last NUL is a whole record only if nothing was cut (then it is empty).
  if (cut) fields.pop();
  const found: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    if (field === '') continue;
    const kind = field[0];
    if (kind === '?' || kind === '!') {
      found.push({ kind, xy: `${kind}${kind}`, sub: 'N...', modes: [], path: field.slice(2) });
    } else if (kind === '1' || kind === '2' || kind === 'u') {
      const count = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const parts = splitFields(field, count);
      if (parts === undefined) continue;
      const [, xy = '', sub = '', ...rest] = parts.fields;
      const modes = kind === 'u' ? rest.slice(0, 4) : rest.slice(0, 3);
      const entry: StatusEntry = { kind, xy, sub, modes, path: parts.rest };
      if (kind === '2') {
        i++;
        entry.from = fields[i] ?? '';
      }
      found.push(entry);
    }
  }
  return found;
}

/** `text`'s first `count` space-separated fields and the rest (which may hold spaces). */
function splitFields(text: string, count: number): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    const space = text.indexOf(' ', at);
    if (space < 0) return undefined;
    fields.push(text.slice(at, space));
    at = space + 1;
  }
  return { fields, rest: text.slice(at) };
}

/**
 * What another Git leaves in your checkout's Git directories while it works, if anything: an
 * operation in progress, a lock on the index, or a lock on a ref the install updates (the install
 * would stop between your files and its ref). Never removed: whoever holds them may still be at
 * work. The clean check refuses each; a restart's reconciliation holds a merge that finds one.
 */
export function anotherGit(
  destination: Pick<MergeDestination, 'gitDir' | 'commonDir' | 'branch'>,
):
  | { kind: 'in-progress'; what: string }
  | { kind: 'index-lock' }
  | { kind: 'ref-lock' }
  | undefined {
  for (const [name, what] of IN_PROGRESS) {
    if (present(path.join(destination.gitDir, name))) return { kind: 'in-progress', what };
  }
  if (present(path.join(destination.gitDir, 'index.lock'))) return { kind: 'index-lock' };
  const refLocks = [
    path.join(destination.gitDir, 'HEAD.lock'),
    path.join(destination.gitDir, 'ORIG_HEAD.lock'),
    path.join(destination.gitDir, 'reftable', 'tables.list.lock'),
    path.join(destination.commonDir, `${destination.branch}.lock`),
    path.join(destination.commonDir, 'packed-refs.lock'),
    path.join(destination.commonDir, 'reftable', 'tables.list.lock'),
  ];
  return refLocks.some(present) ? { kind: 'ref-lock' } : undefined;
}

/**
 * Your checkout clean, as §9 C4 has it, and in a layout merging supports (C11): or why not.
 * Writes nothing and takes no lock.
 */
export async function checkClean(
  git: GitRunner,
  destination: MergeDestination,
): Promise<MergeRefusal | undefined> {
  const refusedOrig = await checkOrigHead(git, destination);
  if (refusedOrig !== undefined) return refusedOrig;
  const busy = anotherGit(destination);
  if (busy?.kind === 'in-progress') {
    return refuse(
      'refused',
      'in-progress',
      `Your checkout has ${busy.what} in progress: finish it or abort it there, then merge again.`,
    );
  }
  if (busy?.kind === 'index-lock') {
    return refuse(
      'unavailable',
      'index-lock',
      'Another Git is working in your checkout (its index is locked): merge again once it’s done.',
    );
  }
  if (busy?.kind === 'ref-lock') {
    return refuse(
      'unavailable',
      'ref-lock',
      `Another Git is updating ${shown(destination.branch)} in your checkout (its ref is locked): merge again once it’s done.`,
    );
  }
  try {
    // Merging's own Git, asked through the merge profile: an older one refuses before this runs.
    const shallow = await git.run({
      ...there(destination),
      merge: { drivers: destination.mergeDrivers },
      args: ['rev-parse', '--is-shallow-repository'],
    });
    if (shallow.stdout.trim() !== 'false') {
      return refuse(
        'refused',
        'shallow',
        'Your repository is a shallow clone, missing history a merge needs: fetch all of it (git fetch --unshallow), then merge again.',
      );
    }
    if (present(path.join(destination.commonDir, 'info', 'grafts'))) {
      return refuse(
        'refused',
        'grafts',
        'Your repository has grafts (.git/info/grafts), which rewrite its history: corrallm doesn’t merge there.',
      );
    }
    const settings = await configured(git, destination, [
      'core.sparsecheckout',
      'index.sparse',
      'core.splitindex',
    ]);
    if (settings.get('core.sparsecheckout') === 'true' || settings.get('index.sparse') === 'true') {
      return refuse(
        'refused',
        'sparse',
        'Your checkout is sparse: corrallm doesn’t merge into a sparse checkout.',
      );
    }
    const shared = await git.run({
      ...there(destination),
      args: ['rev-parse', '--shared-index-path'],
    });
    if (settings.get('core.splitindex') === 'true' || shared.stdout.trim() !== '') {
      return refuse(
        'refused',
        'split-index',
        'Your checkout’s index is split (core.splitIndex): corrallm doesn’t merge into a split index.',
      );
    }
    let status;
    try {
      status = await git.run({
        ...there(destination),
        maxBytes: LISTING_BYTES,
        args: [
          '--no-optional-locks',
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=dirty',
        ],
      });
    } catch (error) {
      if (error instanceof GitError && error.fault === 'output') {
        return refuse(
          'refused',
          'dirty',
          'Your checkout has more uncommitted changes than corrallm lists: commit or stash them, then merge again.',
        );
      }
      throw error;
    }
    if (status.stderr.trim() !== '') {
      return refuse(
        'unavailable',
        'unreadable',
        'Git couldn’t read all of your checkout (git status there says why), so corrallm doesn’t merge into it.',
      );
    }
    const entries = statusEntries(status.stdout);
    const unmerged = entries.filter((entry) => entry.kind === 'u');
    if (unmerged.length > 0) {
      return refuse(
        'refused',
        'unmerged',
        `${branchPathSentence(
          'Your checkout has unmerged files',
          unmerged.slice(0, 5).map((entry) => entry.path),
          unmerged.length,
        )} Resolve them, then merge again.`,
      );
    }
    if (entries.length > 0) {
      return refuse(
        'refused',
        'dirty',
        `${branchPathSentence(
          'Your checkout has uncommitted changes',
          entries.slice(0, 5).map((entry) => entry.path),
          entries.length,
        )} Commit or stash them, then merge again; if you didn’t change them, run git status there (it refreshes what your filters checked out) and merge again.`,
      );
    }
    const index = await git.run({
      ...there(destination),
      maxBytes: LISTING_BYTES,
      args: ['ls-files', '-v', '-z'],
    });
    const hidden = hiddenEntries(index.stdout);
    if (hidden.length > 0) {
      return refuse(
        'refused',
        'index-flags',
        `${branchPathSentence(
          'Your checkout marks files skip-worktree or assume-unchanged, which hide their changes from Git',
          hidden.slice(0, 5),
          hidden.length,
        )} Clear the marks (git update-index --no-skip-worktree or --no-assume-unchanged), then merge again.`,
      );
    }
    return undefined;
  } catch (error) {
    return gitRefusal(error, 'read your checkout');
  }
}

/** The paths `ls-files -v -z` marks skip-worktree (S) or assume-unchanged (a lowercase tag). */
export function hiddenEntries(stdout: string): string[] {
  return stdout
    .split('\0')
    .filter((entry) => entry.length > 2 && /^(?:S|[a-z]) /.test(entry))
    .map((entry) => entry.slice(2));
}

/** Boolean settings where a call in `cwd` runs, as Git normalizes them: by lowercased name. */
async function configured(
  git: GitRunner,
  destination: Pick<MergeDestination, 'root' | 'drivers'> & { root: string },
  names: readonly string[],
): Promise<Map<string, string>> {
  const pattern = `^(${names.map((name) => name.replace(/\./g, '\\.')).join('|')})$`;
  const { stdout } = await git.run({
    cwd: destination.root,
    drivers: destination.drivers,
    args: ['config', '-z', '--type=bool', '--get-regexp', pattern],
    answers: [1],
  });
  const found = new Map<string, string>();
  for (const entry of stdout.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline < 0) continue;
    // The last of a name wins, as Git reads it.
    found.set(entry.slice(0, newline).toLowerCase(), entry.slice(newline + 1));
  }
  return found;
}

/** ORIG_HEAD as it is in the destination's own Git directory. */
export type OrigHead =
  | { kind: 'none' }
  | { kind: 'oid'; oid: string }
  /** A symbolic ref, naming another ref. */
  | { kind: 'symbolic' }
  /** Something Git can't read as a ref, or ambiguous with a ref of that name. */
  | { kind: 'unreadable' };

/**
 * ORIG_HEAD as it is (never through another ref): none, a commit, a symbolic ref, or unreadable.
 * Read for the merge service to record before the install and to check after it.
 */
export async function readOrigHead(
  git: GitRunner,
  destination: MergeDestination,
): Promise<OrigHead> {
  const read = (args: string[], answers: number[]) =>
    git.run({ cwd: destination.root, drivers: destination.drivers, args, answers });
  const symbolic = await read(['symbolic-ref', '--quiet', '--no-recurse', 'ORIG_HEAD'], [1, 128]);
  if (symbolic.code === 0) return { kind: 'symbolic' };
  if (symbolic.code !== 1) return { kind: 'unreadable' };
  // Which ref Git takes ORIG_HEAD for: a branch of that name is not it.
  const named = await read(
    ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', 'ORIG_HEAD'],
    [1],
  );
  if (named.code === 1 || named.stdout.trim().startsWith('refs/')) return { kind: 'none' };
  if (named.stdout.trim() !== 'ORIG_HEAD') return { kind: 'unreadable' };
  const value = await read(['rev-parse', '--verify', '--quiet', 'ORIG_HEAD'], [1]);
  const oid = value.stdout.trim();
  if (value.code === 1) return { kind: 'none' };
  return OID.test(oid) ? { kind: 'oid', oid } : { kind: 'unreadable' };
}

/** Refused unless ORIG_HEAD is a plain ref, or none: at the clean check, and last before the install. */
export async function checkOrigHead(
  git: GitRunner,
  destination: MergeDestination,
): Promise<MergeRefusal | undefined> {
  let found: OrigHead;
  try {
    found = await readOrigHead(git, destination);
  } catch (error) {
    return gitRefusal(error, 'read your checkout');
  }
  if (found.kind === 'symbolic') {
    return refuse(
      'refused',
      'orig-head',
      'Your checkout’s ORIG_HEAD is a symbolic ref: corrallm merges only where it is a plain ref. Remove it (git update-ref --no-deref -d ORIG_HEAD), then merge again.',
    );
  }
  if (found.kind === 'unreadable') {
    return refuse(
      'unavailable',
      'orig-head',
      'Git can’t read your checkout’s ORIG_HEAD as a ref, so corrallm doesn’t merge into it.',
    );
  }
  return undefined;
}

/**
 * Puts ORIG_HEAD back after a fast-forward Git refused (§9.3 step 7) or a restart found never
 * installed (C8): to `recorded` (none: deleted), only if it is still what Git wrote there, `wrote`,
 * by `update-ref --no-deref`. Its metadata (ORIG_HEAD, its log) is verified before and after.
 * `changed` if it isn't what Git wrote: left as it is.
 */
export async function restoreOrigHead(
  git: GitRunner,
  destination: MergeDestination,
  { recorded, wrote }: { recorded: string | null; wrote: string },
): Promise<'restored' | 'changed'> {
  if (!OID.test(wrote) || (recorded !== null && !OID.test(recorded))) {
    throw new TypeError('ORIG_HEAD is put back only to and from object ids.');
  }
  const writes = { checkout: destination.gitDir };
  verifyMergeWrites(destination.commonDir, writes);
  try {
    await git.run({
      cwd: destination.root,
      drivers: destination.drivers,
      args:
        recorded === null
          ? ['update-ref', '--no-deref', '-d', 'ORIG_HEAD', wrote]
          : ['update-ref', '--no-deref', 'ORIG_HEAD', recorded, wrote],
    });
    return 'restored';
  } catch (error) {
    if (!(error instanceof GitError) || error.fault !== 'failed') throw error;
    // Refused because it isn't what Git wrote (any more): left as it is. Otherwise, a failure.
    const now = await readOrigHead(git, destination);
    if (now.kind === 'oid' && now.oid === wrote) throw error;
    return 'changed';
  } finally {
    verifyMergeWrites(destination.commonDir, writes);
  }
}

/** A path a merge changes in your checkout, as `diff-tree --raw` says it. */
export interface IncomingChange {
  /** Its repository-relative path, as UTF-8 (a name that isn't is shown lossy, `lossy` true). */
  path: string;
  lossy: boolean;
  status: 'added' | 'modified' | 'deleted' | 'type-changed';
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

const STATUSES: Readonly<Record<string, IncomingChange['status']>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type-changed',
};

/** What `diff-tree -r -z --no-renames` printed: undefined if any of it isn't what it prints. */
export function rawChanges(stdout: string): IncomingChange[] | undefined {
  const fields = stdout.split('\0');
  const found: IncomingChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const head = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([AMDT])$/.exec(
      fields[i] ?? '',
    );
    const at = fields[i + 1] ?? '';
    if (head === null || at === '') return undefined;
    const [, oldMode = '', newMode = '', oldOid = '', newOid = '', letter = ''] = head;
    const status = STATUSES[letter];
    if (status === undefined) return undefined;
    found.push({
      path: at,
      lossy: at.includes(REPLACEMENT),
      status,
      oldMode,
      newMode,
      oldOid,
      newOid,
    });
  }
  return found;
}

/** What a merge changes in your checkout: the changes from `from` (your branch's commit) to `to`. */
export async function incomingChanges(
  git: GitRunner,
  destination: MergeDestination,
  { from, to }: { from: string; to: string },
): Promise<Selected<IncomingChange[]>> {
  if (!OID.test(from) || !OID.test(to)) throw new TypeError('A merge is between object ids.');
  try {
    const { stdout } = await git.run({
      ...there(destination),
      maxBytes: LISTING_BYTES,
      // A submodule's change is never hidden, whatever diff.ignoreSubmodules or .gitmodules say.
      args: ['diff-tree', '-r', '-z', '--no-renames', '--ignore-submodules=none', from, to],
    });
    const changes = rawChanges(stdout);
    if (changes === undefined) {
      return {
        ok: false,
        refusal: refuse('unavailable', 'git', 'Git couldn’t list what the merge changes.'),
      };
    }
    return { ok: true, value: changes };
  } catch (error) {
    if (error instanceof GitError && error.fault === 'output') {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'too-many',
          'This merge changes more files than corrallm checks: merge it yourself in your checkout.',
        ),
      };
    }
    return { ok: false, refusal: gitRefusal(error, 'list what the merge changes') };
  }
}

/**
 * The code points HFS+ ignores in names (as Git's own `.git` check lists them), by range: none may
 * make two names one where corrallm compares them.
 */
const IGNORABLE: readonly (readonly [number, number])[] = [
  [0x200c, 0x200f],
  [0x202a, 0x202e],
  [0x206a, 0x206f],
  [0xfeff, 0xfeff],
];

/** A path as the destination's filesystem compares it: case-folded where Git says it is. */
export function folded(at: string, ignoreCase: boolean): string {
  // By code point, which is how they are listed and how HFS+ ignores them.
  const plain = Array.from(at)
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return !IGNORABLE.some(([low, high]) => point >= low && point <= high);
    })
    .join('');
  return ignoreCase ? plain.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC') : plain;
}

/** Whether `at` (folded) is corrallm's worktrees folder, inside it, or one of its folders. */
function protectedPath(at: string): boolean {
  return at === '.corral' || at === '.corral/worktrees' || at.startsWith('.corral/worktrees/');
}

/** Refused if the merge writes anything into corrallm's worktrees folder (§9 C4). */
export function checkProtected(
  destination: MergeDestination,
  incoming: readonly IncomingChange[],
): MergeRefusal | undefined {
  const into = incoming.filter((change) =>
    protectedPath(folded(change.path, destination.ignoreCase)),
  );
  if (into.length === 0) return undefined;
  return refuse(
    'refused',
    'corral-worktrees',
    `${branchPathSentence(
      'This merge writes where corrallm keeps its worktrees (.corral/worktrees)',
      into.slice(0, 5).map((change) => change.path),
      into.length,
    )} corrallm never merges there.`,
  );
}

/** Refused if the merge changes a submodule (a gitlink): §9 C11. */
export function checkGitlinks(
  incoming: readonly IncomingChange[],
  branch: string,
): MergeRefusal | undefined {
  const links = incoming.filter(
    (change) => change.oldMode === '160000' || change.newMode === '160000',
  );
  if (links.length === 0) return undefined;
  return refuse(
    'refused',
    'gitlink',
    `${branchPathSentence(
      'This merge changes a submodule, which corrallm doesn’t merge',
      links.slice(0, 5).map((change) => change.path),
      links.length,
    )}${yourself(branch)}`,
  );
}

/** `paths` split into lists of at most NAMES_BYTES each, for one call each. */
function batches(paths: readonly string[]): string[][] {
  const found: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const one of paths) {
    const size = Buffer.byteLength(one) + 1;
    if (current.length > 0 && bytes + size > NAMES_BYTES) {
      found.push(current);
      current = [];
      bytes = 0;
    }
    current.push(one);
    bytes += size;
  }
  if (current.length > 0) found.push(current);
  return found;
}

/**
 * Of `paths` (repository-relative, UTF-8), those whose `filter` attribute names a driver
 * configured where `cwd` is (`drivers`), as `check-attr` reads it there: none if none is
 * configured, without asking.
 */
export async function filteredPaths(
  git: GitRunner,
  { cwd, drivers }: { cwd: string; drivers: readonly string[] },
  paths: readonly string[],
): Promise<string[]> {
  if (drivers.length === 0 || paths.length === 0) return [];
  const configured = new Set(drivers);
  const found: string[] = [];
  for (const batch of batches(paths)) {
    const { stdout } = await git.run({
      cwd,
      drivers,
      noReplaceObjects: true,
      timeoutMs: MERGE_TIMEOUT_MS,
      maxBytes: LISTING_BYTES,
      args: ['--literal-pathspecs', 'check-attr', '-z', 'filter', '--', ...batch],
    });
    const fields = stdout.split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (configured.has(fields[i + 2] ?? '')) found.push(fields[i] ?? '');
    }
  }
  return found;
}

/**
 * Refused if the merge writes a file a filter configured in your checkout applies to, or changes a
 * `.gitattributes` while any filter is configured (§9 C9a, §8's answer): corrallm never runs a
 * repository's filter, so it can't write such a file as your checkout expects. A name that isn't
 * UTF-8 can't be asked about: refused rather than guessed. None of it is asked where no filter is.
 */
export async function checkFiltered(
  git: GitRunner,
  destination: MergeDestination,
  incoming: readonly IncomingChange[],
  branch: string,
): Promise<MergeRefusal | undefined> {
  if (destination.drivers.length === 0) return undefined;
  const writes = incoming.filter((change) => change.status !== 'deleted');
  const lossy = writes.filter((change) => change.lossy);
  if (lossy.length > 0) {
    return refuse(
      'refused',
      'lossy-name',
      `${branchPathSentence(
        'This merge writes files whose names aren’t UTF-8, so corrallm can’t check which of your repository’s filters apply to them',
        lossy.slice(0, 5).map((change) => change.path),
        lossy.length,
      )}${yourself(branch)}`,
    );
  }
  const attributes = incoming.filter(
    (change) =>
      path.posix.basename(folded(change.path, destination.ignoreCase)) === '.gitattributes',
  );
  if (attributes.length > 0) {
    return refuse(
      'refused',
      'attributes',
      `${branchPathSentence(
        'This merge changes .gitattributes, which decide the files your repository filters, and corrallm never runs a repository’s filters',
        attributes.slice(0, 5).map((change) => change.path),
        attributes.length,
      )}${yourself(branch)}`,
    );
  }
  let filtered: string[];
  try {
    filtered = await filteredPaths(
      git,
      { cwd: destination.root, drivers: destination.drivers },
      writes.map((change) => change.path),
    );
  } catch (error) {
    return gitRefusal(error, 'read your checkout’s attributes');
  }
  if (filtered.length === 0) return undefined;
  return refuse(
    'refused',
    'filtered',
    `${branchPathSentence(
      'This merge writes files your repository filters (Git LFS, say), and corrallm never runs a repository’s filters, so it can’t write them as your checkout expects',
      filtered.slice(0, 5),
      filtered.length,
    )}${yourself(branch)}`,
  );
}

/**
 * Refused unless every object the merge's tree adds (`to`'s tree, apart from `from`'s) is in your
 * repository: a partial clone's missing one would be fetched, which corrallm never does, and the
 * install would stop part way. `rev-list --missing=print`: asked, never fetched.
 */
export async function checkObjects(
  git: GitRunner,
  destination: MergeDestination,
  { from, to }: { from: string; to: string },
  incoming: readonly IncomingChange[],
): Promise<MergeRefusal | undefined> {
  if (!OID.test(from) || !OID.test(to)) throw new TypeError('A merge is between object ids.');
  let stdout: string;
  try {
    ({ stdout } = await git.run({
      ...there(destination),
      maxBytes: LISTING_BYTES,
      args: ['rev-list', '--objects', '--missing=print', `${to}^{tree}`, `^${from}^{tree}`],
    }));
  } catch (error) {
    if (error instanceof GitError && error.fault === 'output') {
      return refuse(
        'refused',
        'too-many',
        'This merge writes more than corrallm checks: merge it yourself in your checkout.',
      );
    }
    return gitRefusal(error, 'check the merge’s objects');
  }
  const missing = new Set(
    stdout
      .split('\n')
      .filter((line) => line.startsWith('?'))
      .map((line) => line.slice(1).trim()),
  );
  if (missing.size === 0) return undefined;
  const files = incoming
    .filter((change) => missing.has(change.newOid))
    .map((change) => change.path);
  const reason =
    'Some of what this merge writes isn’t in your repository (a partial clone fetches it when asked; corrallm never fetches)';
  return refuse(
    'refused',
    'missing-objects',
    `${files.length > 0 ? branchPathSentence(reason, files.slice(0, 5), files.length) : `${reason}.`} Merge it yourself in your checkout.`,
  );
}

/**
 * Ignored files of your checkout where the merge writes (§9 C4's pre-flight), to name them in a
 * refusal: one at a path it writes, a file or link where it makes a folder, or one inside a folder
 * it makes a file. A new file into an ignored folder is fine. Compared case-folded where the
 * filesystem is. Best effort: past its bound it is skipped; Git's own check at the install, which
 * refuses all of these, is the guarantee.
 */
export async function checkIgnored(
  git: GitRunner,
  destination: MergeDestination,
  incoming: readonly IncomingChange[],
  { maxBytes = IGNORED_BYTES }: { maxBytes?: number } = {},
): Promise<{ refusal?: MergeRefusal; skipped: boolean }> {
  let stdout: string;
  try {
    ({ stdout } = await git.run({
      ...there(destination),
      maxBytes,
      args: ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    }));
  } catch (error) {
    if (error instanceof GitError && error.fault === 'output') return { skipped: true };
    return { refusal: gitRefusal(error, 'list your checkout’s ignored files'), skipped: false };
  }
  const fold = (at: string) => folded(at, destination.ignoreCase);
  const writes = new Set(
    incoming.filter((change) => change.status !== 'deleted').map((change) => fold(change.path)),
  );
  const folders = new Set<string>();
  for (const at of writes) for (const above of ancestors(at)) folders.add(above);
  const collisions = stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .filter((entry) => {
      const folder = entry.endsWith('/');
      const at = fold(folder ? entry.slice(0, -1) : entry);
      return (
        writes.has(at) ||
        (!folder && folders.has(at)) ||
        ancestors(at).some((above) => writes.has(above))
      );
    });
  if (collisions.length === 0) return { skipped: false };
  return {
    refusal: refuse(
      'refused',
      'ignored-collision',
      `${branchPathSentence(
        'Your checkout has ignored files where this merge writes',
        collisions.slice(0, 5),
        collisions.length,
      )} Move them aside, then merge again.`,
    ),
    skipped: false,
  };
}

/** The folders `at` is in, outermost first. */
function ancestors(at: string): string[] {
  const parts = at.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * Every check of what a merge from `from` (your branch's commit) to `to` (the prepared merge
 * commit) writes, in order: corrallm's folder, submodules, filters, objects, then ignored files.
 */
export async function checkIncoming(
  git: GitRunner,
  destination: MergeDestination,
  { from, to, branch }: { from: string; to: string; branch: string },
): Promise<MergeRefusal | undefined> {
  const changes = await incomingChanges(git, destination, { from, to });
  if (!changes.ok) return changes.refusal;
  const incoming = changes.value;
  return (
    checkProtected(destination, incoming) ??
    checkGitlinks(incoming, branch) ??
    (await checkFiltered(git, destination, incoming, branch)) ??
    (await checkObjects(git, destination, { from, to }, incoming)) ??
    (await checkIgnored(git, destination, incoming)).refusal
  );
}
