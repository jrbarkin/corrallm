import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { bindingPlan } from '../../../shared/model/workspaces';
import type { BindingPlan, WorkspaceOwnerKey } from '../../../shared/model/workspaces';
import { OpFailure } from '../call';
import { safe } from './cleanup';
import type { Removal, TreeState, WorkspaceCleanup } from './cleanup';
import { ProvisionError } from './provision';
import type { Base, Provisioner } from './provision';
import { ACTIVE_STATES } from './store';
import type { AgentBinding, RepositoryRecord, WorkspaceStore, WorktreeRecord } from './store';

/*
 * The workspaces' side of every change to a canvas's document (B9a Design §3, "Grouping,
 * ungrouping and project changes"): a participant at the document's commit seam
 * (canvas/documents.ts), which an op's change (a doc op, a batch), a file's Apply and a discard's
 * revert all go through, so no path changes who works where without it.
 *
 * Planning is pure, over the records as the write finds them and the document before and after
 * (shared/model/workspaces.ts' bindingPlan chooses each outermost group's or lone agent's tree):
 *
 * - An agent with no workspace yet that joins a component with one is bound to it at once (a new
 *   member joins a group's tree), at a generation of its own. One whose component has none yet gets
 *   one on demand, by provisioning, from the project's HEAD (an independent add) or forked from
 *   the tree a member works in when it is made (a split: `forkSource`).
 * - A component whose fork source only the commit knows, none of whose members works elsewhere (a
 *   spawn outside a shared group, copying an agent with a tree; members moved out of a tree still
 *   being made), gets its tree in the commit: its base read in the preflight (the source's
 *   committed HEAD, never its uncommitted files), then, in the write, the workspace `creating`
 *   with its job's intent and `forked_from`, its members bound to it (`make`); it is made once
 *   the write is on disk (`made`: as a start's tree is, its setup offered), or as the next core
 *   starts. No Git runs in a commit's write.
 * - An agent whose tree would change while its tree is materialized (made, and maybe worked in) is
 *   not moved: its change waits (`plan`: the owner it is to move to, at a desired generation past
 *   its active one), new starts and sends wait for it, and its session keeps its old tree, claim
 *   and events until you approve the switch. Moving it back clears the change. One still being made
 *   (`creating`) is moved at once: nothing ran there.
 * - A tree a lone agent or a group head keeps as it gains or loses members changes owner, never
 *   checkout: it keeps its path, branch and every binding's generation.
 * - A removed agent is unbound; a tree no agent is bound to any more is retained, its work and
 *   branch kept, never removed (cleanup is your decision: C7).
 *
 * Before a commit's point of no return (`preflight`, the loss preflight), the plan is made over the
 * records as they are and refused while a tree it changes is being restored (the workspace
 * mutation gate); what it keeps and holds (`Losses`) is said for whoever asks you about it. Within
 * the commit's write (`within`), it is made again and applied there, so the document and who works
 * where are on disk together or not at all, across a crash too. A project change keeps every old
 * tree, unbinding its agents, and moves the project's generation on (`projectChanged`).
 */

/** A change of who works where, as a commit makes it. */
export type Step =
  | { kind: 'bind'; agent: string; workspace: string }
  /**
   * A tree made for `owner` in this commit, forked from the workspace `from` (its committed HEAD),
   * `agents` bound to it: a component whose fork source the commit alone knows (a spawn's copy, a
   * member moved out of a tree still being made) and none of whose members works elsewhere.
   */
  | { kind: 'make'; owner: WorkspaceOwnerKey; from: string; agents: readonly string[] }
  | { kind: 'plan'; agent: string; owner: WorkspaceOwnerKey }
  | { kind: 'clear'; agent: string }
  | { kind: 'unbind'; agent: string }
  | { kind: 'retain'; workspace: string }
  | { kind: 'owner'; workspace: string; owner: WorkspaceOwnerKey };

/** What a change keeps and holds of the canvas's workspaces: none of it lost unless you decide. */
export interface Losses {
  /** Trees it leaves with no agent: retained, with their work and branch, unless removed. */
  retained: readonly string[];
  /** Agents whose move waits for you: their sessions keep their old trees meanwhile. */
  pending: readonly string[];
  /** Agents it removes that had a workspace. */
  removed: readonly string[];
  /**
   * What each tree it leaves with no agent holds now (B9a C7: cleanup.ts' `assess`), for its
   * removal's decision: removed with its last agent if safe, else asked (none without cleanup).
   */
  trees?: readonly TreeState[];
}

/** A tree's fork, as a commit's preflight read it: the workspace it forks, and the base read there. */
export interface Fork {
  from: string;
  base: Base;
}

/** The forks a commit makes, by the owner each new tree is for. */
export type Forks = ReadonlyMap<WorkspaceOwnerKey, Fork>;

/** What a commit's preflight found: what it keeps and holds, and the bases of the trees it forks. */
export interface Preflight extends Losses {
  /** Read by the workspace Git runner before the write, recorded within it (`within`). */
  forks?: Forks;
}

/** What was decided of each tree a commit leaves with no agent, by workspace: removed, as said. */
export type Removals = ReadonlyMap<string, Removal>;

/** The create jobs a commit's write recorded, by id: run once it is on disk (`made`). */
export type Made = readonly string[];

/**
 * Of the trees a change leaves with no agent, those safe to remove without asking (clean, merged,
 * no one writing there): removed, with their branches. The others are kept.
 */
export function safeRemovals(losses: Losses | undefined): Removals {
  return new Map(
    (losses?.trees ?? []).flatMap((tree): [string, Removal][] =>
      safe(tree)
        ? [[tree.workspace, { branch: true, force: false, approved: null, tip: tree.tip }]]
        : [],
    ),
  );
}

export interface WorkspacePlan {
  steps: readonly Step[];
  losses: Losses;
}

/** A commit, as the workspaces read it. */
export interface PlannedCommit {
  canvas: CanvasId;
  before: CanvasDocument;
  after: CanvasDocument;
  /** New agents copied from another (spawnAgent's), new → source. */
  copies?: ReadonlyMap<string, string> | undefined;
  /** Within its write: the forks its preflight read (Preflight's). */
  forks?: Forks | undefined;
}

export interface WorkspacePlannerDeps {
  workspaces: WorkspaceStore;
  /** Why new work for an agent waits now, if it does: a restore of its tree (the mutation gate). */
  holding?: (canvas: CanvasId, agent: string) => Promise<string | undefined>;
  /**
   * Provisioning (provision.ts): a fork's base read before the write, its intent recorded within
   * it, and its job run once it is on disk. None: every new tree is made on demand, from the
   * project's HEAD.
   */
  provisioner?: Pick<Provisioner, 'base' | 'intend' | 'run'>;
  /**
   * Makes a tree a commit recorded, once it is on disk: the resolver's provisioning (its job run,
   * then its setup offered, as a start's is). None: its job is run alone.
   */
  make?: (tree: WorktreeRecord) => Promise<unknown>;
  /**
   * A tree's cleanup (B9a C7): what it holds, its removal marked within a commit's write, and run
   * once that is on disk. None: trees are only ever retained.
   */
  cleanup?: Pick<WorkspaceCleanup, 'assess' | 'intend' | 'remove'>;
}

const RESTORING =
  'A workspace this change would change is being restored just now: try again once that is done.';
const CHANGED = 'The workspaces this change makes changed while it was checked: try again.';

export class WorkspacePlanner {
  readonly #deps: WorkspacePlannerDeps;

  constructor(deps: WorkspacePlannerDeps) {
    this.#deps = deps;
  }

  /**
   * The loss preflight, before a commit's point of no return: its plan over the records as they
   * are, refused (OpFailure, changing nothing) while a tree it changes is being restored, or while
   * the committed HEAD a tree it makes forks can't be read; what it keeps and holds, and the base
   * of each tree it forks (read by the workspace Git runner here, never in the write).
   */
  async preflight(commit: PlannedCommit): Promise<Preflight> {
    const plan = this.plan(commit);
    const affected = new Set([
      ...plan.losses.removed,
      ...plan.losses.pending,
      ...plan.steps.flatMap((step) =>
        'agent' in step ? [step.agent] : step.kind === 'make' ? step.agents : [],
      ),
    ]);
    for (const agent of affected) {
      if ((await this.#deps.holding?.(commit.canvas, agent)) !== undefined) {
        throw new OpFailure('unavailable', RESTORING);
      }
    }
    const forks = await this.#forks(commit.canvas, plan.steps);
    const found: Preflight = forks === undefined ? plan.losses : { ...plan.losses, forks };
    const { cleanup } = this.#deps;
    if (cleanup === undefined || plan.losses.retained.length === 0) return found;
    // One still being made is kept, never asked about: nothing ran there, and its job may go on.
    const trees = await Promise.all(
      plan.losses.retained.flatMap((id) => {
        const tree = this.#deps.workspaces.worktree(id);
        return tree === undefined || tree.state === 'creating' ? [] : [cleanup.assess(tree)];
      }),
    );
    return { ...found, trees };
  }

  /** The base of each tree the steps fork, as Git says now: none if they make none. */
  async #forks(canvas: CanvasId, steps: readonly Step[]): Promise<Forks | undefined> {
    const { provisioner, workspaces } = this.#deps;
    const makes = steps.filter((step) => step.kind === 'make');
    if (provisioner === undefined || makes.length === 0) return undefined;
    const repository = repositoryOf(workspaces, canvas);
    if (repository === undefined) return undefined;
    const forks = new Map<WorkspaceOwnerKey, Fork>();
    for (const { owner, from } of makes) {
      const source = workspaces.worktree(from);
      if (source === undefined) throw new OpFailure('conflict', CHANGED);
      try {
        forks.set(owner, { from, base: await provisioner.base(repository, source) });
      } catch (error) {
        if (error instanceof ProvisionError) throw new OpFailure('unavailable', error.message);
        throw error;
      }
    }
    return forks;
  }

  /**
   * Within a commit's write, after its rows: its plan, made again over the records there, applied;
   * a tree it leaves with no agent removed if `removals` says so (marked `removing`, its job
   * recorded: `removed` runs it once the write is on disk), else retained; a tree it forks
   * recorded `creating` at the base its preflight read (`commit.forks`), with its job's intent,
   * its members bound to it. What it returns, `made` runs once the write is on disk.
   */
  within(commit: PlannedCommit, removals?: Removals): Made {
    const { steps } = this.plan(commit);
    const workspaces = this.#deps.workspaces;
    const made: string[] = [];
    for (const step of steps) {
      if (step.kind === 'make') {
        const job = this.#make(commit, step);
        if (job !== undefined) made.push(job);
        continue;
      }
      if (step.kind === 'retain') {
        const removal = removals?.get(step.workspace);
        if (removal !== undefined && this.#deps.cleanup !== undefined) {
          this.#deps.cleanup.intend(workspaces, step.workspace, removal);
          continue;
        }
      }
      switch (step.kind) {
        case 'unbind':
          workspaces.unbind(commit.canvas, step.agent);
          break;
        case 'bind':
          workspaces.bind(commit.canvas, step.agent, step.workspace);
          break;
        case 'plan':
          workspaces.plan(commit.canvas, step.agent, step.owner);
          break;
        case 'clear':
          workspaces.clearPlan(commit.canvas, step.agent);
          break;
        case 'retain':
          workspaces.retain(step.workspace);
          break;
        case 'owner':
          workspaces.setOwner(step.workspace, step.owner);
          break;
      }
    }
    return made;
  }

  /**
   * Within a write: the tree a `make` step forks, recorded with its job (Provisioner's `intend`:
   * no Git, no file), its members bound to it. Fails the write if the preflight read no base for
   * it (the plan changed since). Without provisioning, its members are left to get theirs on
   * demand.
   */
  #make(commit: PlannedCommit, step: Extract<Step, { kind: 'make' }>): string | undefined {
    const { provisioner, workspaces } = this.#deps;
    if (provisioner === undefined) {
      for (const agent of step.agents) workspaces.unbind(commit.canvas, agent);
      return undefined;
    }
    const fork = commit.forks?.get(step.owner);
    const repository = repositoryOf(workspaces, commit.canvas);
    if (fork?.from !== step.from || repository === undefined) throw new Error(CHANGED);
    const { worktree, job } = provisioner.intend(workspaces, {
      canvas: commit.canvas,
      repository,
      owner: step.owner,
      base: fork.base,
      forkedFrom: fork.from,
    });
    for (const agent of step.agents) workspaces.bind(commit.canvas, agent, worktree.id);
    return job?.id;
  }

  /** A commit's new trees, once it is on disk: each one made (in the background). */
  made(jobs: Made | undefined): void {
    const { provisioner, make, workspaces } = this.#deps;
    if (provisioner === undefined) return;
    for (const id of jobs ?? []) {
      const job = workspaces.job(id);
      const tree = job === undefined ? undefined : workspaces.worktree(job.workspace);
      const making = make !== undefined && tree !== undefined ? make(tree) : provisioner.run(id);
      void making.catch((error: unknown) => {
        console.error('Could not make a workspace:', error);
      });
    }
  }

  /** A commit's removals, once it is on disk: each tree's removal run (in the background). */
  removed(removals: Removals | undefined): void {
    const { cleanup } = this.#deps;
    if (cleanup === undefined) return;
    for (const workspace of removals?.keys() ?? []) {
      void cleanup.remove(workspace).catch((error: unknown) => {
        console.error('Could not remove a workspace:', error);
      });
    }
  }

  /** The commit's plan, over the canvas's records as they are now. */
  plan(commit: PlannedCommit): WorkspacePlan {
    const workspaces = this.#deps.workspaces;
    const link = workspaces.canvasRepository(commit.canvas);
    const trees = workspaces.worktreesOf(commit.canvas);
    const bindings = workspaces.bindingsOf(commit.canvas);
    if (trees.length === 0 && bindings.length === 0) return NOTHING;
    return workspacePlan({
      ...commit,
      repository: repositoryOf(workspaces, commit.canvas),
      generation: link?.generation ?? 0,
      trees,
      bindings,
    });
  }

  /**
   * The canvas's project folder is another now: `projectChanged` in a write of its own, on disk
   * once it resolves; rejects, changing nothing, if it couldn't be written.
   */
  projectChosen(canvas: CanvasId, repository: string | null | undefined): Promise<void> {
    return this.#deps.workspaces.write(() => {
      this.projectChanged(canvas, repository);
    });
  }

  /**
   * Within a write: the canvas's project folder is another now (project.choose), the repository
   * it is (none: a folder that isn't one; undefined: not known, as none is discovered yet). Every
   * tree in use is kept, its agents unbound (their changes waiting with them), and the project's
   * generation moves on: new bindings are of the new pick. A missing old repository is no
   * permission to forget its records. Nothing for a canvas that had none and gets none.
   */
  projectChanged(canvas: CanvasId, repository: string | null | undefined): void {
    const workspaces = this.#deps.workspaces;
    const link = workspaces.canvasRepository(canvas);
    const trees = workspaces.worktreesOf(canvas);
    if (link === undefined && trees.length === 0 && (repository ?? null) === null) return;
    for (const binding of workspaces.bindingsOf(canvas)) workspaces.unbind(canvas, binding.agent);
    for (const tree of trees) if (ACTIVE_STATES.includes(tree.state)) workspaces.retain(tree.id);
    workspaces.bindCanvas(canvas, repository ?? null);
  }
}

const NOTHING: WorkspacePlan = { steps: [], losses: { retained: [], pending: [], removed: [] } };

/**
 * What a commit changes of who works where (pure): steps in the order they apply (unbinding,
 * binding, plans, then trees left unbound retained, then owners), and what it keeps and holds.
 */
export function workspacePlan({
  canvas,
  before,
  after,
  copies,
  repository,
  generation,
  trees,
  bindings,
}: PlannedCommit & {
  /** The repository the canvas's project is: none if it isn't one, or none is known. */
  repository: RepositoryRecord | undefined;
  /** The canvas's project generation. */
  generation: number;
  trees: readonly WorktreeRecord[];
  bindings: readonly AgentBinding[];
}): WorkspacePlan {
  const byId = new Map(trees.map((tree) => [tree.id, tree]));
  const bound = new Map(bindings.map((binding) => [binding.agent, binding]));
  const agents = new Set(after.nodes.flatMap((node) => (node.type === 'agent' ? [node.id] : [])));
  const removed = bindings.filter(({ agent }) => !agents.has(agent)).map(({ agent }) => agent);
  const moves: Step[] = removed.map((agent) => ({ kind: 'unbind', agent }));
  const pending: string[] = [];
  const targets = new Set<string>();
  const owners: Step[] = [];
  if (repository !== undefined) {
    const plan = plannedOf({ before, after, copies, repository, generation, trees, bindings });
    for (const { owner, target, bindings: members } of plan.components) {
      const into = target.kind === 'reuse' ? byId.get(target.workspace) : undefined;
      if (into !== undefined) {
        targets.add(into.id);
        if (into.owner !== owner.key) {
          owners.push({ kind: 'owner', workspace: into.id, owner: owner.key });
        }
      }
      // A new tree forked from a workspace (B9a Design §3: a spawn outside a shared group forks
      // its source's committed HEAD; a split branches from the former group's commit).
      const fork =
        target.kind === 'create' && target.source.kind === 'workspace'
          ? target.source.workspace
          : undefined;
      const making: string[] = [];
      let waits = false;
      for (const { agent, previous } of members) {
        const kept = bound.get(agent);
        if (previous === null) {
          if (into !== undefined) moves.push({ kind: 'bind', agent, workspace: into.id });
          else if (fork !== undefined) making.push(agent);
          continue;
        }
        if (previous.workspace === into?.id) {
          // Back where it works: a change that waited is gone.
          if (kept?.desired != null) moves.push({ kind: 'clear', agent });
          continue;
        }
        const from = byId.get(previous.workspace);
        if (from?.state === 'creating') {
          // Nothing ran where it was being made: it moves at once.
          if (into !== undefined) moves.push({ kind: 'bind', agent, workspace: into.id });
          else if (fork !== undefined) making.push(agent);
          else moves.push({ kind: 'unbind', agent });
          continue;
        }
        // Materialized: its move waits for you, its session kept in its old tree meanwhile.
        waits = true;
        pending.push(agent);
        if (kept?.desired?.owner !== owner.key)
          moves.push({ kind: 'plan', agent, owner: owner.key });
      }
      if (fork !== undefined && making.length > 0) {
        if (!waits) {
          // Its source is known to this commit alone (a spawn's copy, a tree still being made
          // that its members leave): the fork is recorded in its write, its members bound to it.
          moves.push({ kind: 'make', owner: owner.key, from: fork, agents: making });
        } else {
          // A member works elsewhere still: its tree is made on demand (a start, or your Switch),
          // forked from where that member works then (`forkSource`).
          for (const agent of making) if (bound.has(agent)) moves.push({ kind: 'unbind', agent });
        }
      }
    }
  }
  // Who is bound where once the moves apply: a tree no one is bound to is retained.
  const where = new Map(bindings.map(({ agent, workspace }) => [agent, workspace]));
  for (const step of moves) {
    if (step.kind === 'unbind') where.delete(step.agent);
    else if (step.kind === 'bind') where.set(step.agent, step.workspace);
    else if (step.kind === 'make') for (const agent of step.agents) where.delete(agent);
  }
  const used = new Set(where.values());
  const nodes = new Set(after.nodes.map((node) => node.id));
  const retained = trees
    .filter(
      (tree) =>
        ACTIVE_STATES.includes(tree.state) &&
        tree.canvas === canvas &&
        !used.has(tree.id) &&
        !targets.has(tree.id) &&
        // One an agent was bound to, or whose owner has left the document: no one's now.
        (bindings.some(({ workspace }) => workspace === tree.id) ||
          !nodes.has(ownerNode(tree.owner))),
    )
    .map((tree) => tree.id);
  return {
    steps: [
      ...moves,
      ...retained.map((workspace): Step => ({ kind: 'retain', workspace })),
      ...owners,
    ],
    losses: { retained, pending, removed },
  };
}

/**
 * The workspace a new tree for `owner` forks, as the canvas's plan says now (pure, over its records
 * and document): the tree one of its members works in, if it moves there from one; none if it
 * starts from the project's HEAD, or has a tree already. What provisioning on demand (a start, a
 * Switch's destination) forks, so a split made when it switches branches from the former group's
 * commit then.
 */
export function forkSource(
  workspaces: WorkspaceStore,
  canvas: CanvasId,
  document: CanvasDocument,
  owner: WorkspaceOwnerKey,
): WorktreeRecord | undefined {
  const repository = repositoryOf(workspaces, canvas);
  if (repository === undefined) return undefined;
  const component = plannedOf({
    before: document,
    after: document,
    repository,
    generation: workspaces.canvasRepository(canvas)?.generation ?? 0,
    trees: workspaces.worktreesOf(canvas),
    bindings: workspaces.bindingsOf(canvas),
  }).components.find((one) => one.owner.key === owner);
  const source = component?.target.kind === 'create' ? component.target.source : undefined;
  return source?.kind === 'workspace' ? workspaces.worktree(source.workspace) : undefined;
}

/** The repository the canvas's project is, as its records say: none if it isn't one, or none is known. */
function repositoryOf(workspaces: WorkspaceStore, canvas: CanvasId): RepositoryRecord | undefined {
  const id = workspaces.canvasRepository(canvas)?.repository ?? null;
  return id === null ? undefined : workspaces.repository(id);
}

/** shared/model/workspaces.ts' binding plan, over the canvas's records. */
function plannedOf({
  before,
  after,
  copies,
  repository,
  generation,
  trees,
  bindings,
}: {
  before: CanvasDocument;
  after: CanvasDocument;
  copies?: ReadonlyMap<string, string> | undefined;
  repository: RepositoryRecord;
  generation: number;
  trees: readonly WorktreeRecord[];
  bindings: readonly AgentBinding[];
}): BindingPlan {
  return bindingPlan({
    before,
    after,
    repository: { id: repository.id, generation, ref: null, revision: '' },
    bindings: bindings.map(({ agent, workspace, generation: at }) => ({
      agent,
      workspace,
      generation: at,
    })),
    workspaces: trees.map((tree) => ({
      id: tree.id,
      canvas: tree.canvas,
      repository: tree.repository,
      owner: tree.owner,
      revision: null,
      active: ACTIVE_STATES.includes(tree.state),
    })),
    ...(copies === undefined ? {} : { copies }),
  });
}

/** The node an owner key names (its root: a lone agent, or a group's outermost node). */
export function ownerNode(owner: string): string {
  const encoded = owner.slice(owner.indexOf('/') + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
