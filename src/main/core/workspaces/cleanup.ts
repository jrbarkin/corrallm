import { createHash, randomUUID } from 'node:crypto';

import type { CanvasId } from '../../../shared/canvas';
import { checkCheckout } from './checkout';
import { GitError } from './git';
import type { GitRunner } from './git';
import { ProvisioningQueue } from './queue';
import { WorkspaceStoreError } from './store';
import type { Json, JobRecord, WorkspaceStore, WorktreeRecord } from './store';

/*
 * A workspace's cleanup and retention (B9a Design §3, "Deletion and retention"; §7; B9a C7): what
 * becomes of a tree no agent works in any more, and how one is removed, safely, once you decided.
 *
 * - **What a tree holds** (`assess`): as Git and the file system say now, in its verified checkout
 *   (never a path read back unchecked): its HEAD and its generated branch's tip, how many files are
 *   changed or untracked there (and the first of their paths, to name them), whether its HEAD and
 *   tip are both reachable from the picked checkout's HEAD now (merged; its base commit alone isn't
 *   proof), and which agents may still be writing there (a turn, a setup, a close that didn't
 *   finish). What Git couldn't read is unknown: never taken for safe. Its fingerprint changes
 *   whenever any of it does: what an approval is bound to.
 * - **Safe** is clean, merged and with no writer: such a tree is removed with its last agent,
 *   without asking. Anything else asks you first (the deletion's confirmation, R4's proposal), and
 *   keeps the tree unless you chose to discard it.
 * - **Removing** (`intend`, within the write that settles the decision, whatever made it: a
 *   delete's commit, an Allow, a kept tree's Remove): the workspace `removing`, with a `remove` job
 *   saying what was decided (its branch deleted too, the fingerprint you approved). Then, outside
 *   SQL, in its repository's lane of the provisioning queue (`remove`): its writers waited for,
 *   briefly; it is assessed again and must still be what was decided (the fingerprint you
 *   approved, or safe), else it is kept (`retained`), never destroying work added while you
 *   decided; its checkout verified, then removed by Git (forced only for a discard you approved);
 *   its branch deleted only at the commit it was decided at; its setup's log and copy record
 *   removed; and its record forgotten, its job finished, in one write. A step that fails leaves it
 *   `removing` with its error code, said in the kept trees, tried again as the core next starts
 *   (`reconcile`) or when you remove it again: never reported done before it is.
 * - **Kept trees** (`kept`): every retained or removing workspace of the profile's canvases, with
 *   its former owner, branch, state and error: the way back to work its agent no longer reaches.
 *
 * Nothing here deletes a folder itself or follows a link: Git removes the registered checkout it
 * made, once it verifies as that. Nothing here waits for a person.
 */

/** The most paths a tree's state names; how many there are is counted whatever. */
const NAMED_PATHS = 20;
/** How long removal waits for a tree's writers to stop (a session's bounded close), then leaves it. */
const SETTLE_MS = 10_000;
const SETTLE_POLL_MS = 100;

/** What a tree holds now, as Git says. */
export interface TreeState {
  workspace: string;
  /** Its checkout's HEAD now, and its branch's tip (none: there is none). */
  head: string | null;
  tip: string | null;
  /** How many files are changed (tracked) and untracked there, and the first of their paths. */
  changed: number;
  untracked: number;
  paths: readonly string[];
  /** Whether its HEAD and its branch's tip are both reachable from the picked checkout's HEAD. */
  merged: boolean;
  /** The agents that may still be writing there. */
  writers: readonly string[];
  /** Whether its setup command runs (or waits to run) there: a writer too. */
  setup: boolean;
  /** Why it couldn't be checked, if it couldn't: unknown, never safe. */
  unknown?: string;
  /** Its status as Git printed it, hashed: what changes when any of its files does. */
  status: string;
}

/** Whether a tree is safe to remove without asking: clean, merged, and no one writing there. */
export function safe(state: TreeState): boolean {
  return (
    state.unknown === undefined &&
    state.changed === 0 &&
    state.untracked === 0 &&
    state.merged &&
    state.writers.length === 0 &&
    !state.setup
  );
}

/** A tree's state's fingerprint: what an approval of its removal is bound to. */
export function fingerprint(state: TreeState): string {
  const { workspace, head, tip, changed, untracked, merged, writers, setup, unknown, status } =
    state;
  return createHash('sha256')
    .update(
      JSON.stringify([
        'corrallm tree 1',
        workspace,
        head,
        tip,
        changed,
        untracked,
        merged,
        [...writers].sort(),
        setup,
        unknown ?? null,
        status,
      ]),
    )
    .digest('hex');
}

/** What was decided of a tree no agent works in: removed (how), or kept. */
export interface Removal {
  /** Its generated branch deleted too (only at the commit it was decided at). */
  branch: boolean;
  /** Removed whatever its checkout holds: a discard you approved. */
  force: boolean;
  /** The fingerprint you approved (none: removed as safe, which it must still be). */
  approved: string | null;
  /** Its branch's tip as decided: deleted only if it is still there. */
  tip: string | null;
}

/**
 * Your decision of what becomes of the trees a deletion leaves with no agent, on its confirmation
 * (B9a C7): kept, or discarded, each as it was when you were asked (its fingerprint).
 */
export interface CleanupDecision {
  choice: 'keep' | 'discard';
  fingerprints: Readonly<Record<string, string>>;
}

/** A tree kept, or being removed, for the Kept worktrees section. */
export interface KeptTree {
  workspace: string;
  canvas: CanvasId;
  /** Whose it was: its owner key, and the name of its agent or group, if the canvas still names it. */
  owner: string;
  name: string | null;
  branch: string;
  base: { ref: string | null; oid: string };
  state: 'retained' | 'removing';
  /** Why its removal failed, if it did. */
  error: string | null;
  createdAt: number;
}

/** How a removal ended. */
export type Removed = 'removed' | 'retained' | 'failed' | 'waiting';

export interface WorkspaceCleanupDeps {
  workspaces: WorkspaceStore;
  git: GitRunner;
  /** The provisioning queue: removals run in their repository's lane, as its jobs do. */
  queue?: ProvisioningQueue;
  /** The agents that may be writing in a workspace's checkout now (a turn, a close). */
  writers?: (tree: WorktreeRecord) => Promise<readonly string[]> | readonly string[];
  /** Whether a workspace's setup command runs (or waits to run) now. */
  setupRunning?: (workspace: string) => boolean;
  /** What a workspace's setup kept (its log, its copy record): forgotten once the tree is gone. */
  forgetSetup?: (workspace: string) => Promise<void>;
  /** The name of the agent or group an owner key names on its canvas, if it still does. */
  nameOf?: (canvas: CanvasId, owner: string) => string | undefined;
  /** Hears that a canvas's kept trees (or Needs) may have changed. */
  changed?: (canvas: CanvasId) => void;
  /** Hears that a canvas owns no workspace record any more. */
  released?: (canvas: CanvasId) => void;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class WorkspaceCleanup {
  readonly #deps: WorkspaceCleanupDeps;
  readonly #queue: ProvisioningQueue;
  /** Each removal going on, by workspace: asked again, it is the same one. */
  readonly #removing = new Map<string, Promise<Removed>>();
  #closing = false;

  constructor(deps: WorkspaceCleanupDeps) {
    this.#deps = deps;
    this.#queue = deps.queue ?? new ProvisioningQueue();
  }

  /** What the workspace's tree holds now: unknown where it couldn't be read. */
  async assess(tree: WorktreeRecord): Promise<TreeState> {
    const writers = [...((await this.#deps.writers?.(tree)) ?? [])];
    const setup = this.#deps.setupRunning?.(tree.id) === true;
    const blank = { workspace: tree.id, head: null, tip: null, changed: 0, untracked: 0, setup };
    const unknown = (why: string): TreeState => ({
      ...blank,
      paths: [],
      merged: false,
      writers,
      unknown: why,
      status: '',
    });
    const repository = this.#deps.workspaces.repository(tree.repository);
    if (repository === undefined) return unknown('its repository isn’t known any more');
    const checked = await checkCheckout(this.#deps.git, repository, tree);
    const { git } = this.#deps;
    try {
      const base = await git.inspect(repository.realRoot);
      if (base.refusals.length > 0) return unknown(base.refusals.join(' '));
      const tip = await this.#commit(repository.realRoot, base.drivers, tree.branchRef);
      if (!checked.ok) {
        return {
          ...unknown(
            checked.fault === 'checkout-missing' ? 'its checkout is gone' : checked.detail,
          ),
          tip,
        };
      }
      const local = await git.inspect(tree.path);
      if (local.refusals.length > 0) return unknown(local.refusals.join(' '));
      const drivers = [...new Set([...base.drivers, ...local.drivers])];
      const { stdout } = await git.run({
        cwd: tree.path,
        drivers,
        args: [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=none',
        ],
      });
      const entries = statusEntries(stdout);
      const head = await this.#commit(tree.path, drivers, 'HEAD');
      const baseHead = await this.#commit(repository.realRoot, base.drivers, 'HEAD');
      const reachable = async (oid: string | null) =>
        oid === null ||
        (baseHead !== null &&
          (
            await git.run({
              cwd: repository.realRoot,
              drivers: base.drivers,
              answers: [1],
              args: ['merge-base', '--is-ancestor', '--end-of-options', oid, baseHead],
            })
          ).code === 0);
      return {
        workspace: tree.id,
        head,
        tip,
        changed: entries.filter(({ untracked }) => !untracked).length,
        untracked: entries.filter(({ untracked }) => untracked).length,
        paths: entries.slice(0, NAMED_PATHS).map(({ path }) => path),
        merged: head !== null && (await reachable(head)) && (await reachable(tip)),
        writers,
        setup,
        status: createHash('sha256').update(stdout).digest('hex'),
      };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return unknown(error.message);
    }
  }

  /**
   * Within a write: the workspace to be removed as decided: `removing`, its job recorded with the
   * decision. Its removal runs once the write is on disk (`remove`), or as the core next starts.
   */
  intend(workspaces: WorkspaceStore, workspace: string, removal: Removal): void {
    const tree = workspaces.markRemoving(workspace);
    const open = workspaces.openJob(workspace, 'remove');
    // Decided again (a kept tree removed after a failed attempt): its decision is the latest.
    if (open !== undefined) workspaces.finishJob(open.id, 'superseded');
    workspaces.recordJob({
      id: randomUUID(),
      workspace,
      kind: 'remove',
      phase: 'recorded',
      generation: tree.generation,
      payload: removal as unknown as Json,
    });
  }

  /**
   * Removes a workspace marked `removing`, as its job says, once it is safe: how it ended. The
   * same removal however often asked meanwhile.
   */
  remove(workspace: string): Promise<Removed> {
    const going = this.#removing.get(workspace);
    if (going !== undefined) return going;
    // The core closing: left `removing`, for the next start.
    if (this.#closing) return Promise.resolve('waiting');
    const tree = this.#deps.workspaces.worktree(workspace);
    if (tree === undefined) return Promise.resolve('removed');
    const repository = this.#deps.workspaces.repository(tree.repository);
    if (tree.state !== 'removing' || repository === undefined) return Promise.resolve('failed');
    const removing = this.#queue
      .run(repository.commonDir, () => this.#remove(workspace))
      .catch(async (error: unknown) => {
        await this.#failed(workspace, 'cleanup-failed');
        console.error('Could not remove a workspace:', error);
        return 'failed' as const;
      })
      .finally(() => this.#removing.delete(workspace));
    this.#removing.set(workspace, removing);
    return removing;
  }

  /**
   * As the core closes, before its process owner does: no removal starts, and those going on
   * finish (one waiting for a writer stops waiting, left for the next start).
   */
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#removing.values()]);
  }

  /** As the core starts, after its children's recovery: every removal not finished, again. */
  async reconcile(): Promise<void> {
    const trees = this.#deps.workspaces.worktreesIn(['removing']);
    await Promise.allSettled(trees.map((tree) => this.remove(tree.id)));
  }

  /** The kept trees: every retained or removing workspace (of one canvas, if given), oldest first. */
  kept(canvas?: CanvasId): KeptTree[] {
    const trees = this.#deps.workspaces.worktreesIn(['retained', 'removing']);
    return trees
      .filter((tree) => canvas === undefined || tree.canvas === canvas)
      .map((tree) => ({
        workspace: tree.id,
        canvas: tree.canvas,
        owner: tree.owner,
        name: this.#deps.nameOf?.(tree.canvas, tree.owner) ?? null,
        branch: tree.branchRef.slice('refs/heads/'.length),
        base: { ref: tree.baseRef, oid: tree.baseOid },
        state: tree.state as 'retained' | 'removing',
        error: tree.errorCode,
        createdAt: tree.createdAt,
      }));
  }

  async #remove(workspace: string): Promise<Removed> {
    const { workspaces, git } = this.#deps;
    const tree = workspaces.worktree(workspace);
    if (tree === undefined) return 'removed';
    if (tree.state !== 'removing') return 'failed';
    const repository = workspaces.repository(tree.repository);
    if (repository === undefined) return this.#failed(workspace, 'cleanup-repository');
    const job = workspaces.openJob(workspace, 'remove');
    const removal = removalOf(job);
    // Its writers stop first (a removed agent's session closing), for a bounded while.
    let state = await this.assess(tree);
    const until = Date.now() + (this.#deps.settleMs ?? SETTLE_MS);
    while ((state.writers.length > 0 || state.setup) && Date.now() < until && !this.#closing) {
      await (this.#deps.sleep ?? sleep)(SETTLE_POLL_MS);
      state = await this.assess(tree);
    }
    if (state.writers.length > 0 || state.setup) {
      await this.#failed(workspace, 'cleanup-writing');
      return 'waiting';
    }
    // Still what was decided: never work added since.
    const decided =
      removal.approved === null ? safe(state) : fingerprint(state) === removal.approved;
    if (!decided) {
      await workspaces.write((w) => {
        w.transition(workspace, { from: 'removing', to: 'retained' });
        if (job !== undefined) w.finishJob(job.id, 'superseded');
      });
      this.#changed(tree.canvas);
      return 'retained';
    }
    const base = await git.inspect(repository.realRoot);
    if (base.refusals.length > 0) return this.#failed(workspace, 'cleanup-config');
    const checked = await checkCheckout(git, repository, tree);
    if (checked.ok) {
      await git.run({
        cwd: repository.realRoot,
        drivers: base.drivers,
        args: [
          'worktree',
          'remove',
          ...(removal.force ? ['--force'] : []),
          '--end-of-options',
          checked.checkout.path,
        ],
      });
    } else if (checked.fault !== 'checkout-missing') {
      // Not the checkout made, or not readable: nothing there is removed.
      return this.#failed(workspace, `cleanup-${checked.fault}`);
    }
    if (removal.branch && state.tip !== null && state.tip === removal.tip) {
      // Only at the commit it was decided at: a branch someone moved since is kept.
      await git.run({
        cwd: repository.realRoot,
        drivers: base.drivers,
        answers: [1],
        args: ['update-ref', '-d', '--end-of-options', tree.branchRef, state.tip],
      });
    }
    await this.#deps.forgetSetup?.(workspace);
    await workspaces.write((w) => {
      for (const open of w.jobsOf(workspace).filter(({ outcome }) => outcome === null)) {
        w.finishJob(open.id, 'done');
      }
      w.forget(workspace);
    });
    this.#changed(tree.canvas);
    if (workspaces.worktreesOf(tree.canvas).length === 0) this.#deps.released?.(tree.canvas);
    return 'removed';
  }

  /** Its removal failed: still `removing`, saying why, to be tried again. */
  async #failed(workspace: string, code: string): Promise<'failed'> {
    try {
      await this.#deps.workspaces.write((w) => {
        if (w.worktree(workspace)?.state === 'removing') {
          w.transition(workspace, { from: 'removing', to: 'removing', errorCode: code });
        }
      });
    } catch (error) {
      if (!(error instanceof WorkspaceStoreError)) throw error;
    }
    const tree = this.#deps.workspaces.worktree(workspace);
    if (tree !== undefined) this.#changed(tree.canvas);
    return 'failed';
  }

  /** The commit `ref` names where `cwd` is, if it names one. */
  async #commit(cwd: string, drivers: readonly string[], ref: string): Promise<string | null> {
    const { code, stdout } = await this.#deps.git.run({
      cwd,
      drivers,
      answers: [1],
      args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    });
    const oid = stdout.trim();
    return code === 0 && oid !== '' ? oid : null;
  }

  #changed(canvas: CanvasId): void {
    try {
      this.#deps.changed?.(canvas);
    } catch (error) {
      console.error('Could not tell of a workspace’s cleanup:', error);
    }
  }
}

/** What a remove job decided: as safe, if none was recorded. */
function removalOf(job: JobRecord | undefined): Removal {
  const payload = job?.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { branch: true, force: false, approved: null, tip: null };
  }
  const { branch, force, approved, tip } = payload as Record<string, Json>;
  return {
    branch: branch === true,
    force: force === true,
    approved: typeof approved === 'string' ? approved : null,
    tip: typeof tip === 'string' ? tip : null,
  };
}

/** The entries of `git status --porcelain=v1 -z`: each path, and whether it is untracked. */
function statusEntries(stdout: string): { path: string; untracked: boolean }[] {
  const entries: { path: string; untracked: boolean }[] = [];
  const fields = stdout.split('\0');
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at] ?? '';
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ path: field.slice(3), untracked: code === '??' });
    // A rename or copy names its source next.
    if (code.includes('R') || code.includes('C')) at += 1;
  }
  return entries;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
