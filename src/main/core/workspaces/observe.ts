import type { CanvasId } from '../../../shared/canvas';
import type { TrustedPath } from '../host';
import { verifiedCheckout } from './checkout';
import { GitError } from './git';
import type { GitCall, GitRunner } from './git';
import { WORKTREE_READ_CONFIG } from './merge-checks';
import { findDestination } from './merge-select';
import type { DestinationSeen } from './merge-select';
import type { RepositoryRecord, WorkspaceStore, WorktreeRecord, WorktreeState } from './store';
import { uncommittedCount } from './uncommitted';

/*
 * B9b's merge state, as each agent's card shows it (Design §9 C12): an observation service in the
 * core, never the list selector, which only reads what it found and so never runs Git.
 *
 * - **What it keeps.** Per workspace: its generated branch's tip; whether that tip is in the
 *   history of the commit your picked checkout is on now (`merged`, ancestry as cleanup's: a
 *   reverted merge keeps it, a new commit on the branch clears it), never said of a branch with no
 *   commits of its own beyond its recorded base (its tip at its base: nothing of its is merged or
 *   not); and how many paths are uncommitted in its tree, as Review changes counts them (tracked
 *   changes, staged or not, and untracked files), never said of a tree whose checkout is off its
 *   branch. Per canvas: your picked checkout's branch and commit, as Review changes reads them
 *   (`findDestination`'s `seen`: a detached HEAD is no branch, what can't be read is neither).
 * - **When.** Only when asked: a merge settling (at once, `now`, so its answer's receipt carries
 *   it), Review changes reading a page, a member's turn ending or its session closing, a window
 *   showing the canvas gaining focus. What asks is coalesced to one pass per repository every 2
 *   seconds (`OBSERVE_EVERY_MS`), at most 64 workspaces a pass (`OBSERVE_PER_PASS`; the rest at the
 *   next), each a few read-only Git calls through the one runner that take no lock and run no
 *   program a repository configures; one pass of a repository at a time, repositories apart. No
 *   renderer polls it, and nothing reads Git to render a card or commit a document.
 * - **Truthfully.** What couldn't be read is unknown (null), never clean or merged; an answer read
 *   against one commit of yours is never shown against another (`merged` is unknown until the tree
 *   is read again); a tree no longer `setup` or `ready`, or made again since, shows nothing read.
 * - **Published.** A pass that changed what a canvas shows asks for its worktrees to be read again
 *   (`changed`), which moves their canonical revision; one that changed nothing publishes nothing.
 */

/** How often one repository is observed at most, a pass's trigger to its next. */
export const OBSERVE_EVERY_MS = 2000;
/** How many workspaces one pass reads at most: the rest wait for the next. */
export const OBSERVE_PER_PASS = 64;

/** How long reading a tree's status may take (a large tree's untracked files), and print. */
const STATUS_TIMEOUT_MS = 60_000;
const STATUS_BYTES = 64 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The trees it reads: made, verified once, agents working there or about to. */
const OBSERVED: readonly WorktreeState[] = ['setup', 'ready'];

/** What one pass read of a workspace. */
export interface WorkspaceRead {
  tip: string | null;
  merged: boolean | null;
  uncommitted: number | null;
}

/** How it reads: Git (`gitReads`), or a test's. */
export interface ObserverReads {
  /** Your picked checkout's branch and commit, as Review changes reads them. */
  into: (picked: TrustedPath, repository: RepositoryRecord) => Promise<DestinationSeen>;
  /** A workspace's tree: its branch's tip, whether it's in `against`'s history, what's uncommitted. */
  workspace: (
    repository: RepositoryRecord,
    tree: WorktreeRecord,
    against: string | null,
  ) => Promise<WorkspaceRead>;
}

const UNKNOWN: WorkspaceRead = { tip: null, merged: null, uncommitted: null };

/** Reads through the one runner, as the merge's own reads do. */
export function gitReads(git: GitRunner): ObserverReads {
  return {
    into: async (picked, repository) => {
      try {
        return (await findDestination(git, { picked, repository })).seen;
      } catch (error) {
        if (error instanceof GitError) return { ref: null, oid: null };
        throw error;
      }
    },
    workspace: (repository, tree, against) => readWorkspace(git, repository, tree, against),
  };
}

/**
 * A workspace's tree, in its verified checkout (never a path read back unchecked), with its
 * filter drivers blanked, replace refs ignored and full stat checks: its branch's tip (a ref of
 * its own, a commit), whether that tip is in `against`'s history, and how many paths are
 * uncommitted there (none said off its branch). Each part that can't be read is unknown.
 */
async function readWorkspace(
  git: GitRunner,
  repository: RepositoryRecord,
  tree: WorktreeRecord,
  against: string | null,
): Promise<WorkspaceRead> {
  const verified = await verifiedCheckout(git, repository, tree);
  if (!verified.ok) return UNKNOWN;
  const { cwd, checkout } = verified;
  let call: Pick<GitCall, 'cwd' | 'drivers' | 'noReplaceObjects' | 'config'>;
  try {
    const inspected = await git.inspect(cwd);
    if (inspected.refusals.length > 0) return UNKNOWN;
    call = {
      cwd,
      drivers: inspected.drivers,
      noReplaceObjects: true,
      config: WORKTREE_READ_CONFIG,
    };
  } catch (error) {
    if (error instanceof GitError) return UNKNOWN;
    throw error;
  }
  const ref = tree.branchRef;
  const tip = await known(async () => {
    const { stdout } = await git.run({
      ...call,
      args: [
        '--no-optional-locks',
        'for-each-ref',
        '--format=%(objectname)%00%(objecttype)%00%(symref)%00%(refname)',
        '--end-of-options',
        ref,
      ],
    });
    // The branch itself, a ref of its own naming a commit: not one below it, nor a symbolic one.
    const line = stdout
      .split('\n')
      .map((one) => one.split('\0'))
      .find(([, , , name]) => name === ref);
    const [oid = '', type, symref] = line ?? [];
    return OID.test(oid) && type === 'commit' && symref === '' ? oid : null;
  });
  if (tip === null) return UNKNOWN;
  const merged =
    tip === tree.baseOid || against === null
      ? null
      : await known(async () => {
          const { code } = await git.run({
            ...call,
            args: [
              '--no-optional-locks',
              'merge-base',
              '--is-ancestor',
              '--end-of-options',
              tip,
              against,
            ],
            answers: [1],
          });
          return code === 0;
        });
  const uncommitted =
    checkout.branch !== ref
      ? null
      : await known(async () => {
          const { stdout, stderr } = await git.run({
            ...call,
            timeoutMs: STATUS_TIMEOUT_MS,
            maxBytes: STATUS_BYTES,
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
          return stderr.trim() === '' ? uncommittedCount(stdout) : null;
        });
  return { tip, merged, uncommitted };
}

/** What `read` answers, or unknown where Git couldn't say. */
async function known<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

export interface MergeObserverDeps {
  workspaces: Pick<
    WorkspaceStore,
    'worktree' | 'repository' | 'canvasRepository' | 'binding' | 'bindingsOf'
  >;
  /** The canvas's picked project folder, as the core keeps it now (none: not chosen or restored). */
  projectRoot: (canvas: CanvasId) => TrustedPath | undefined;
  reads: ObserverReads;
  /** What a canvas shows of its merge state changed: its worktrees to publish again. */
  changed: (canvas: CanvasId) => void;
  /** Tests: the period between one repository's passes, and how many workspaces one reads. */
  everyMs?: number;
  perPass?: number;
}

/** A workspace's merge state, as its card shows it: unknown (null) until it is read. */
export interface MergeObservation {
  merged: boolean | null;
  uncommitted: number | null;
}

/** What it keeps of a workspace: what was read, at which generation, against which commit. */
interface Kept extends WorkspaceRead {
  generation: number;
  against: string | null;
}

/** What it keeps of a canvas's picked checkout: for which repository and project generation. */
interface KeptInto {
  repository: string;
  generation: number;
  seen: DestinationSeen;
}

/** One repository's observation: what waits for its next pass, and its passes, one at a time. */
interface Lane {
  canvases: Set<CanvasId>;
  workspaces: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  tail: Promise<void>;
}

export class MergeObserver {
  readonly #deps: MergeObserverDeps;
  readonly #kept = new Map<string, Kept>();
  readonly #into = new Map<CanvasId, KeptInto>();
  readonly #lanes = new Map<string, Lane>();
  #closed = false;

  constructor(deps: MergeObserverDeps) {
    this.#deps = deps;
  }

  /** A workspace's tree may have changed (a review read it, a turn ended there): read it soon. */
  workspace(workspace: string): void {
    const tree = this.#deps.workspaces.worktree(workspace);
    if (tree === undefined) return;
    this.#ask(tree.repository, [tree.canvas], [workspace]);
  }

  /** An agent's turn ended, or its session closed: its tree read soon. */
  agent(canvas: CanvasId, agent: string): void {
    const binding = this.#deps.workspaces.binding(canvas, agent);
    if (binding !== undefined) this.workspace(binding.workspace);
  }

  /** A window showing the canvas gained focus: your checkout and every tree of it read soon. */
  canvas(canvas: CanvasId): void {
    const repository = this.#deps.workspaces.canvasRepository(canvas)?.repository;
    if (repository === null || repository === undefined) return;
    this.#ask(repository, [canvas], this.#treesOf(canvas, repository));
  }

  /**
   * Your picked checkout, and `workspace`'s tree if given, read at once (after a pass of that
   * repository going on): a merge settled. Resolves once what it read is published. The canvas's
   * other trees, which the change of your commit may change, are read at the next pass.
   */
  async now(canvas: CanvasId, workspace?: string): Promise<void> {
    const repository =
      workspace === undefined
        ? this.#deps.workspaces.canvasRepository(canvas)?.repository
        : this.#deps.workspaces.worktree(workspace)?.repository;
    if (this.#closed || repository === null || repository === undefined) return;
    const lane = this.#lane(repository);
    const pass = lane.tail.then(() =>
      this.#pass(repository, [canvas], workspace === undefined ? [] : [workspace]),
    );
    lane.tail = pass.catch(() => undefined);
    await pass;
  }

  /** Your picked checkout's branch and commit, as last read for the canvas's project now. */
  into(canvas: CanvasId): DestinationSeen | null {
    const kept = this.#into.get(canvas);
    const link = this.#deps.workspaces.canvasRepository(canvas);
    // Read for the canvas's project as it is now: another pick (a new generation) isn't read yet.
    if (
      kept === undefined ||
      link?.repository !== kept.repository ||
      link.generation !== kept.generation
    ) {
      return null;
    }
    return kept.seen;
  }

  /** A workspace's merge state as last read: unknown where it wasn't, or isn't so any more. */
  of(workspace: string): MergeObservation {
    const tree = this.#deps.workspaces.worktree(workspace);
    const kept = this.#kept.get(workspace);
    if (
      tree === undefined ||
      kept?.generation !== tree.generation ||
      !OBSERVED.includes(tree.state)
    ) {
      return { merged: null, uncommitted: null };
    }
    const into = this.into(tree.canvas);
    return {
      merged:
        into !== null && kept.against !== null && kept.against === into.oid ? kept.merged : null,
      uncommitted: kept.uncommitted,
    };
  }

  /** Stops: nothing read from now on, no pass waiting. */
  close(): void {
    this.#closed = true;
    for (const lane of this.#lanes.values()) {
      clearTimeout(lane.timer);
      lane.timer = undefined;
      lane.canvases.clear();
      lane.workspaces.clear();
    }
  }

  /** The trees of `repository` the canvas's agents work in now. */
  #treesOf(canvas: CanvasId, repository: string): string[] {
    const { workspaces } = this.#deps;
    return [
      ...new Set(
        workspaces
          .bindingsOf(canvas)
          .map((binding) => binding.workspace)
          .filter((id) => workspaces.worktree(id)?.repository === repository),
      ),
    ];
  }

  #lane(repository: string): Lane {
    let lane = this.#lanes.get(repository);
    if (lane === undefined) {
      lane = {
        canvases: new Set(),
        workspaces: new Set(),
        timer: undefined,
        tail: Promise.resolve(),
      };
      this.#lanes.set(repository, lane);
    }
    return lane;
  }

  /** What asks waits for the repository's next pass, two seconds on: never sooner than that. */
  #ask(repository: string, canvases: readonly CanvasId[], workspaces: readonly string[]): void {
    if (this.#closed) return;
    const lane = this.#lane(repository);
    for (const canvas of canvases) lane.canvases.add(canvas);
    for (const workspace of workspaces) lane.workspaces.add(workspace);
    this.#schedule(repository, lane);
  }

  #schedule(repository: string, lane: Lane): void {
    if (this.#closed || lane.timer !== undefined) return;
    if (lane.canvases.size === 0 && lane.workspaces.size === 0) return;
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      const canvases = [...lane.canvases];
      lane.canvases.clear();
      const workspaces = [...lane.workspaces].slice(0, this.#deps.perPass ?? OBSERVE_PER_PASS);
      for (const workspace of workspaces) lane.workspaces.delete(workspace);
      const pass = lane.tail.then(() => this.#pass(repository, canvases, workspaces));
      lane.tail = pass.catch((error: unknown) => {
        console.error('Could not observe a repository’s merge state:', error);
      });
      // What waits beyond this pass (more than one pass reads, or asked meanwhile): the next.
      void lane.tail.then(() => {
        this.#schedule(repository, lane);
      });
    }, this.#deps.everyMs ?? OBSERVE_EVERY_MS);
  }

  /**
   * One pass of a repository: each canvas's picked checkout, then each workspace's tree against
   * its canvas's commit now. Each canvas whose shown state changed is published once, after.
   */
  async #pass(
    repository: string,
    canvases: readonly CanvasId[],
    workspaces: readonly string[],
  ): Promise<void> {
    const { reads } = this.#deps;
    const changed = new Set<CanvasId>();
    const record = this.#deps.workspaces.repository(repository);
    for (const canvas of canvases) {
      if (this.#closed) return;
      const link = this.#deps.workspaces.canvasRepository(canvas);
      const before = this.into(canvas);
      const picked = this.#deps.projectRoot(canvas);
      if (link?.repository !== repository || picked === undefined || record === undefined) {
        this.#into.delete(canvas);
      } else {
        const seen = await reads.into(picked, record);
        this.#into.set(canvas, { repository, generation: link.generation, seen });
      }
      const after = this.into(canvas);
      if (before?.ref !== after?.ref || before?.oid !== after?.oid) {
        changed.add(canvas);
        // Your commit moved: what each tree's `merged` was read against with it. Read them again.
        if (before?.oid !== after?.oid) {
          const lane = this.#lane(repository);
          for (const tree of this.#treesOf(canvas, repository)) {
            if (!workspaces.includes(tree)) lane.workspaces.add(tree);
          }
          this.#schedule(repository, lane);
        }
      }
    }
    for (const workspace of workspaces) {
      if (this.#closed) return;
      const tree = this.#deps.workspaces.worktree(workspace);
      const before = this.of(workspace);
      if (tree === undefined || record === undefined || tree.repository !== repository) {
        this.#kept.delete(workspace);
        continue;
      }
      if (!OBSERVED.includes(tree.state)) {
        this.#kept.delete(workspace);
      } else {
        const against = this.into(tree.canvas)?.oid ?? null;
        const read = await reads.workspace(record, tree, against);
        this.#kept.set(workspace, { ...read, generation: tree.generation, against });
      }
      const after = this.of(workspace);
      if (before.merged !== after.merged || before.uncommitted !== after.uncommitted) {
        changed.add(tree.canvas);
      }
    }
    if (this.#closed) return;
    for (const canvas of changed) this.#deps.changed(canvas);
  }
}
