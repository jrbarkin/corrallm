import type { CanvasId } from '../../../shared/canvas';
import type { TrustedPath } from '../host';
import { verifiedCheckout } from './checkout';
import { discoverRepository, realOrNone, registrations } from './discovery';
import { GitError } from './git';
import type { GitRunner } from './git';
import { ACTIVE_STATES } from './store';
import type {
  AgentBinding,
  CanvasRepository,
  RepositoryRecord,
  WorkspaceStore,
  WorktreeRecord,
} from './store';

/*
 * What a branch's review and merge are between (B9b Design §9 C3): the destination, the branch
 * your picked checkout is on, and the source, the agent's generated branch in its verified
 * checkout. Both are read as Git and the file system say now, each time, by the core: no caller
 * names a path, a ref or a commit, and what a caller saw (its pins) is only ever compared with
 * what is read, never passed to Git.
 *
 * - **The destination** (`findDestination`) is found again from the canvas's picked folder, a
 *   TrustedPath (`discoverRepository`), and must be the workspace's repository (its real top level,
 *   common Git directory and identity), its HEAD naming a direct `refs/heads/` branch: not detached
 *   or unborn, not itself a symbolic ref, not one of corrallm's own branches, and checked out in no
 *   other worktree. A linked pick uses its own Git directory, index and HEAD. It is not an owned
 *   root: nothing here makes, marks or verifies one, and no path is minted.
 * - **The source** (`selectSource`) is the agent's active binding's workspace, its checkout
 *   verified (`verifiedCheckout`, the workspaces' one mint site), its generated branch a ref of its
 *   own, and its tip read now. One whose checkout switched to another branch or detached can still
 *   be reviewed (`onBranch` false), never merged; nor can one with a change waiting for your Switch,
 *   or one not `ready` (`checkMergeable`).
 * - **Pins** (`checkInto`, `checkSource`): a branch or commit other than the one the caller saw is
 *   a conflict, so a rebind or a moved branch never redirects a merge someone reviewed.
 *
 * A refusal is the operation's code and a sentence for the person (never a path, never Git's own
 * words), with a reason for the service and its tests.
 */

/** Why a review or merge can't go on: its operation's code, its sentence, and a reason. */
export interface MergeRefusal {
  code: 'refused' | 'conflict' | 'unavailable';
  reason: MergeRefusalReason;
  sentence: string;
}

export type MergeRefusalReason =
  // The destination.
  | 'not-git'
  | 'discovery'
  | 'repository-changed'
  | 'detached'
  | 'not-branch'
  | 'symbolic-branch'
  | 'corrallm-branch'
  | 'checked-out-elsewhere'
  | 'moved'
  // The source.
  | 'no-workspace'
  | 'project-changed'
  | 'checkout'
  | 'symbolic-source'
  | 'no-branch'
  | 'pending-change'
  | 'not-ready'
  | 'off-branch'
  | 'moved-source'
  // Your checkout, and the layouts merging refuses (merge-checks.ts).
  | 'git-unsupported'
  | 'config'
  | 'git'
  | 'orig-head'
  | 'in-progress'
  | 'index-lock'
  | 'ref-lock'
  | 'shallow'
  | 'grafts'
  | 'sparse'
  | 'split-index'
  | 'dirty'
  | 'unmerged'
  | 'unreadable'
  | 'index-flags'
  // What the merge would write (merge-checks.ts).
  | 'too-many'
  | 'corral-worktrees'
  | 'gitlink'
  | 'filtered'
  | 'attributes'
  | 'lossy-name'
  | 'missing-objects'
  | 'ignored-collision';

/** What was found, or why not. */
export type Selected<T> = { ok: true; value: T } | { ok: false; refusal: MergeRefusal };

/** The picked checkout's branch and commit as read, whether or not it can be merged into. */
export interface DestinationSeen {
  /** The full ref HEAD names (null: detached, or unread). */
  ref: string | null;
  oid: string | null;
}

/** The branch a merge goes into, as found for one job: compared, never trusted, at each use. */
export interface MergeDestination {
  /** The workspace's repository record it was checked against, and that repository's identity. */
  repository: string;
  identity: string;
  /** The checkout's real top level, where every call runs. */
  root: string;
  /** Its own Git directory (a linked pick's registration), and the common one. */
  gitDir: string;
  commonDir: string;
  /** The branch HEAD names, a direct `refs/heads/` ref, and its commit. */
  branch: string;
  oid: string;
  /** The filter drivers and custom merge drivers configured there: every call there blanks them. */
  drivers: readonly string[];
  mergeDrivers: readonly string[];
  /** Whether Git there takes names differing only in case for one (core.ignoreCase). */
  ignoreCase: boolean;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** corrallm's own branches: never a destination. */
const CORRALLM_BRANCHES = 'refs/heads/corrallm/';
/** A branch's full ref as Git keeps one: no control character, space or revision syntax. */
const BRANCH =
  // eslint-disable-next-line no-control-regex
  /^refs\/heads\/(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)))[^\x00-\x20\x7f~^:?*[\\]+$/;

export function refuse(
  code: MergeRefusal['code'],
  reason: MergeRefusalReason,
  sentence: string,
): MergeRefusal {
  return { code, reason, sentence };
}

/**
 * A Git failure as a refusal: an older Git, or configuration the runner can't neutralize, says
 * so; anything else (Git failing, taking too long, the core closing) is unavailable, unknown and
 * so never taken for safe.
 */
export function gitRefusal(error: unknown, reading: string): MergeRefusal {
  if (!(error instanceof GitError)) throw error;
  if (error.fault === 'git-unsupported') {
    return refuse('unavailable', 'git-unsupported', error.message);
  }
  if (error.fault === 'config') return refuse('refused', 'config', error.message);
  if (error.fault === 'git-missing') {
    return refuse('unavailable', 'git', 'Git isn’t installed, so corrallm can’t merge.');
  }
  return refuse('unavailable', 'git', `Git couldn’t ${reading} just now: try again.`);
}

/** A branch's short name, as a sentence shows it: quoted if it holds anything unusual. */
export function shown(ref: string): string {
  const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const short = name.length > 200 ? `${name.slice(0, 200)}…` : name;
  return /^[A-Za-z0-9._/-]+$/.test(short) ? short : JSON.stringify(short);
}

/**
 * The branch the canvas's picked checkout is on, found again from the picked folder and checked to
 * be the workspace's repository's: a destination, or why not, with what was seen either way.
 */
export async function findDestination(
  git: GitRunner,
  { picked, repository }: { picked: TrustedPath; repository: RepositoryRecord },
): Promise<Selected<MergeDestination> & { seen: DestinationSeen }> {
  const unseen: DestinationSeen = { ref: null, oid: null };
  const found = await discoverRepository(git, picked);
  if (found.kind === 'not-git') {
    return {
      ok: false,
      refusal: refuse(
        'unavailable',
        'not-git',
        'The project folder isn’t a Git repository, so there is no branch to merge into.',
      ),
      seen: unseen,
    };
  }
  if (found.kind === 'refused') {
    return { ok: false, refusal: refuse('unavailable', 'discovery', found.sentence), seen: unseen };
  }
  const at = found.repository;
  if (
    at.identity !== repository.identity ||
    at.realRoot !== repository.realRoot ||
    at.commonDir !== repository.commonDir
  ) {
    return {
      ok: false,
      refusal: refuse(
        'unavailable',
        'repository-changed',
        'Another repository is at the project folder now: choose the project folder again.',
      ),
      seen: unseen,
    };
  }
  const read = (args: string[]) =>
    git.run({
      cwd: at.realRoot,
      drivers: at.drivers,
      noReplaceObjects: true,
      args,
      answers: [1],
    });
  let seen: DestinationSeen = { ...unseen, oid: at.head.oid };
  try {
    const head = await read(['symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
    if (head.code !== 0) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'detached',
          'Your checkout is on no branch (a detached HEAD): check out the branch to merge into, then merge again.',
        ),
        seen,
      };
    }
    const ref = head.stdout.trim();
    seen = { ref, oid: at.head.oid };
    if (!BRANCH.test(ref)) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'not-branch',
          `Your checkout’s HEAD names ${shown(ref)}, which isn’t a branch: check out a branch to merge into, then merge again.`,
        ),
        seen,
      };
    }
    if (ref.startsWith(CORRALLM_BRANCHES)) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'corrallm-branch',
          'Your checkout is on one of corrallm’s own branches: check out your branch to merge into, then merge again.',
        ),
        seen,
      };
    }
    if ((await read(['symbolic-ref', '--quiet', '--no-recurse', ref])).code === 0) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'symbolic-branch',
          `${shown(ref)} is a symbolic ref naming another branch: corrallm merges only into a branch that is a ref of its own.`,
        ),
        seen,
      };
    }
    const oid = (await read(['rev-parse', '--verify', '--quiet', ref])).stdout.trim();
    const commit = (
      await read(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    ).stdout.trim();
    seen = { ref, oid: OID.test(oid) ? oid : null };
    if (!OID.test(oid) || oid !== commit) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'not-branch',
          `${shown(ref)} doesn’t name a commit, so there is nothing to merge into.`,
        ),
        seen,
      };
    }
    const listed = await git.run({
      cwd: at.realRoot,
      drivers: at.drivers,
      args: ['worktree', 'list', '--porcelain', '-z'],
    });
    // A registration whose folder is gone checks nothing out (Git calls it prunable); a locked
    // one may be on a disk not mounted now, and counts.
    if (
      registrations(listed.stdout).some(
        (entry) =>
          !entry.bare &&
          !entry.prunable &&
          entry.branch === ref &&
          realOrNone(entry.path) !== at.realRoot,
      )
    ) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'checked-out-elsewhere',
          `${shown(ref)} is checked out in another worktree too: corrallm doesn’t merge into a branch checked out twice.`,
        ),
        seen,
      };
    }
    const inspected = await git.inspect(at.realRoot);
    if (inspected.refusals.length > 0) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'config',
          `Your checkout’s Git configuration can’t be made safe to merge into: ${inspected.refusals.join(' ')}`,
        ),
        seen,
      };
    }
    const ignoreCase = await git.run({
      cwd: at.realRoot,
      drivers: at.drivers,
      args: ['config', '--type=bool', '--get', 'core.ignorecase'],
      answers: [1],
    });
    return {
      ok: true,
      value: {
        repository: repository.id,
        identity: at.identity,
        root: at.realRoot,
        gitDir: at.gitDir,
        commonDir: at.commonDir,
        branch: ref,
        oid,
        drivers: inspected.drivers,
        mergeDrivers: inspected.mergeDrivers,
        ignoreCase: ignoreCase.stdout.trim() === 'true',
      },
      seen,
    };
  } catch (error) {
    return { ok: false, refusal: gitRefusal(error, 'read your checkout'), seen };
  }
}

/** The caller's pin of the destination (what it saw) against the destination now. */
export function checkInto(
  destination: MergeDestination,
  into: { ref: string; oid: string },
): MergeRefusal | undefined {
  if (into.ref !== destination.branch) {
    return refuse(
      'conflict',
      'moved',
      `Your checkout is on ${shown(destination.branch)} now, not ${shown(into.ref)}: review the changes again.`,
    );
  }
  if (into.oid !== destination.oid) {
    return refuse(
      'conflict',
      'moved',
      `${shown(destination.branch)} moved since you looked: review the changes again.`,
    );
  }
  return undefined;
}

/** An agent's branch to review or merge: its workspace and checkout, as checked now. */
export interface MergeSource {
  canvas: CanvasId;
  agent: string;
  /** What sentences call the agent. */
  name: string;
  /** Its binding, workspace and repository records, and the canvas's project, as read. */
  binding: AgentBinding;
  workspace: WorktreeRecord;
  repository: RepositoryRecord;
  project: CanvasRepository;
  /** Its checkout, verified now, and that checkout's own Git directory. */
  cwd: TrustedPath;
  gitDir: string;
  /** Its generated branch, and that branch's tip now. */
  ref: string;
  tip: string;
  /** Whether its checkout's HEAD names that branch. */
  onBranch: boolean;
  /** The filter drivers and custom merge drivers configured in its checkout. */
  drivers: readonly string[];
  mergeDrivers: readonly string[];
}

/**
 * The agent's generated branch in its verified checkout, for its review: or why there is none to
 * review. Whether it may be merged is `checkMergeable`'s.
 */
export async function selectSource(
  { git, workspaces }: { git: GitRunner; workspaces: WorkspaceStore },
  { canvas, agent, name }: { canvas: CanvasId; agent: string; name: string },
): Promise<Selected<MergeSource>> {
  const binding = workspaces.binding(canvas, agent);
  const workspace = binding === undefined ? undefined : workspaces.worktree(binding.workspace);
  const repository =
    workspace === undefined ? undefined : workspaces.repository(workspace.repository);
  if (
    binding === undefined ||
    workspace === undefined ||
    repository === undefined ||
    !ACTIVE_STATES.includes(workspace.state)
  ) {
    return {
      ok: false,
      refusal: refuse(
        'unavailable',
        'no-workspace',
        `${name} has no worktree of its own, so there is no branch to review or merge.`,
      ),
    };
  }
  const project = workspaces.canvasRepository(canvas);
  if (project?.repository !== workspace.repository) {
    return {
      ok: false,
      refusal: refuse(
        'unavailable',
        'project-changed',
        `${name}’s worktree is of a project folder this canvas no longer uses.`,
      ),
    };
  }
  const verified = await verifiedCheckout(git, repository, workspace);
  if (!verified.ok) {
    const sentence =
      verified.fault === 'checkout-missing' || verified.fault === 'repository-missing'
        ? `${name}’s worktree is missing.`
        : verified.fault === 'git-failed'
          ? `Git couldn’t check ${name}’s worktree just now: try again.`
          : `${name}’s worktree isn’t the one corrallm made, so corrallm doesn’t read it.`;
    return { ok: false, refusal: refuse('unavailable', 'checkout', sentence) };
  }
  const { cwd } = verified;
  try {
    const inspected = await git.inspect(cwd);
    if (inspected.refusals.length > 0) {
      return {
        ok: false,
        refusal: refuse(
          'unavailable',
          'config',
          `${name}’s worktree has Git configuration corrallm can’t make safe: ${inspected.refusals.join(' ')}`,
        ),
      };
    }
    const read = (args: string[]) =>
      git.run({ cwd, drivers: inspected.drivers, noReplaceObjects: true, args, answers: [1] });
    const ref = workspace.branchRef;
    if ((await read(['symbolic-ref', '--quiet', '--no-recurse', ref])).code === 0) {
      return {
        ok: false,
        refusal: refuse(
          'refused',
          'symbolic-source',
          `${name}’s branch is a symbolic ref naming another branch: corrallm reviews and merges only the branch it made.`,
        ),
      };
    }
    const tip = (await read(['rev-parse', '--verify', '--quiet', ref])).stdout.trim();
    const commit = (
      await read(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    ).stdout.trim();
    if (!OID.test(tip) || tip !== commit) {
      return {
        ok: false,
        refusal: refuse('unavailable', 'no-branch', `${name}’s branch is gone.`),
      };
    }
    const head = await read(['symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
    return {
      ok: true,
      value: {
        canvas,
        agent,
        name,
        binding,
        workspace,
        repository,
        project,
        cwd,
        gitDir: verified.checkout.gitDir,
        ref,
        tip,
        onBranch: head.code === 0 && head.stdout.trim() === ref,
        drivers: inspected.drivers,
        mergeDrivers: inspected.mergeDrivers,
      },
    };
  } catch (error) {
    return { ok: false, refusal: gitRefusal(error, `read ${name}’s worktree`) };
  }
}

/** Whether a source read for its review may be merged now: or why not. */
export function checkMergeable(source: MergeSource): MergeRefusal | undefined {
  const { name } = source;
  if (source.binding.desired !== null) {
    return refuse(
      'unavailable',
      'pending-change',
      `${name}’s move to another worktree waits for your Switch: merge once it’s switched or cancelled.`,
    );
  }
  const state = source.workspace.state;
  if (state !== 'ready') {
    const why =
      state === 'creating'
        ? 'is still being made'
        : state === 'setup'
          ? 'is being set up: merge once it’s ready'
          : state === 'missing'
            ? 'is missing'
            : 'failed: retry it first';
    return refuse('unavailable', 'not-ready', `${name}’s worktree ${why}.`);
  }
  if (!source.onBranch) {
    return refuse(
      'refused',
      'off-branch',
      `${name}’s worktree isn’t on its branch: switch it back, or merge it yourself.`,
    );
  }
  return undefined;
}

/** The caller's pin of the source (what it saw) against the source now. */
export function checkSource(
  source: MergeSource,
  pin: { ref: string; oid: string },
): MergeRefusal | undefined {
  return pin.ref === source.ref && pin.oid === source.tip
    ? undefined
    : refuse(
        'conflict',
        'moved-source',
        `${source.name}’s work changed since you looked: review it again.`,
      );
}
