import type { WorktreeMerge, WorktreeMergeListing } from '../../../shared/api/branch';
import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { workspaceOwners } from '../../../shared/model/workspaces';
import type { WorkspaceOwner, WorkspaceOwnerKey } from '../../../shared/model/workspaces';
import type { KeptTree } from './cleanup';
import { ownerNode } from './planner';
import { setupNeedId } from './setup';
import type {
  AgentBinding,
  SetupSource,
  SetupState,
  WorkspaceStore,
  WorktreeRecord,
} from './store';

/*
 * Who works where on a canvas (B9a Design §7, `worktree.list` and its `worktrees:<c>` topic; C's
 * authorized selector for X12): one item per agent, from the records the directory resolver and
 * cleanup keep, never by asking Git and never making anything (a list never allocates).
 *
 * - **You** see every agent of the canvas, and what is yours alone: where each checkout is, its
 *   setup (the command it would run, from where, how it ended), the card waiting for you on it
 *   (setup or a workspace change), why it failed, and the trees the canvas keeps (Kept worktrees,
 *   whose Remove is yours: `worktree.remove`).
 * - **A token** sees only the agents it reaches now (the caller's reach, read afresh on every
 *   call), with their tree, sharing, branch and state: that its agent waits for setup or for your
 *   Switch, never the command, the card or the path. A shared tree names no member it doesn't
 *   reach: each item is one agent's, and the group's node is named only where the token sees it
 *   (an agent it reaches, or a frame around one, as canvas.get shows it). No kept tree is listed
 *   to a token: their former agents are gone, and their removal is yours.
 * - **The merge state** (B9b Design §9 C12), for everyone alike, as the observation service last
 *   read it (workspaces/observe.ts; nothing here asks Git): at the top, `into`, your picked
 *   checkout's branch and commit; on each item with a tree, `merge`, that tree's (every member's
 *   the same): whether its branch's commits are in that branch's history, how much is uncommitted
 *   there, and a merge of it going on or held. A held merge's sentence is yours alone.
 *
 * A binding whose agent has left the document (its cleanup recorded) is no one's to list.
 */

/** An agent's working directory, as the list says it. */
export type ListedState =
  'no-project' | 'unmade' | 'creating' | 'setup' | 'ready' | 'pending-change' | 'missing' | 'error';

export interface ListedWorktree {
  agent: string;
  /** Its own tree, its group's, or the shared project folder (not a Git repository). */
  mode: 'own' | 'group' | 'shared-folder';
  /** The group's outermost node, where the caller sees it. */
  group?: string;
  /** Its active tree (none yet, or the shared folder), and its binding's generation (0: none). */
  workspace: string | null;
  generation: number;
  /** Its generated branch, and what it was made from. */
  branch: string | null;
  base: { ref: string | null; oid: string } | null;
  state: ListedState;
  /** Yours alone: the card waiting for you on it (its setup, or a workspace change). */
  need?: string;
  /** Yours alone: why it failed, or was lost. */
  error?: string;
  /** Yours alone: where it works. Shown, never taken as a working directory. */
  location?: string;
  /** Yours alone: its setup, as offered. */
  setup?: {
    state: SetupState;
    command: string | null;
    source: SetupSource;
    exitCode: number | null;
  };
  /** Its tree's merge state, when it has a tree (a held merge's sentence yours alone). */
  merge?: WorktreeMerge;
}

/** A tree the canvas keeps (retained, or being removed): yours alone. */
export interface ListedKept {
  workspace: string;
  owner: string;
  name: string | null;
  branch: string;
  base: { ref: string | null; oid: string };
  state: 'retained' | 'removing';
  error: string | null;
  location: string;
  createdAt: number;
}

export interface WorktreeListing extends WorktreeMergeListing {
  items: ListedWorktree[];
  kept: ListedKept[];
  /** Your picked checkout's branch (null: detached) and commit as last read; null: not read. */
  into: { ref: string | null; oid: string | null } | null;
}

/** Who reads the list: you, or a token by the agents it reaches now. */
export type Viewer = { kind: 'you' } | { kind: 'token'; reached: ReadonlySet<string> };

/**
 * What the directory resolver knows of an owner with no tree yet, and of the canvas's project, in
 * memory: provisioning going on, its failure, and what discovery found of the picked folder.
 */
export interface Provisioning {
  making: boolean;
  error?: string;
  project?: { kind: 'repository' | 'not-git' } | { kind: 'refused'; sentence: string };
}

export interface WorktreeListDeps {
  workspaces: Pick<WorkspaceStore, 'canvasRepository' | 'bindingsOf' | 'worktree' | 'setup'>;
  /** The canvas's picked project folder, if one is chosen. */
  projectRoot: (canvas: CanvasId) => string | undefined;
  /** What the resolver is doing for an owner with no tree yet (none: nothing it knows of). */
  provisioning?: (canvas: CanvasId, owner: WorkspaceOwnerKey) => Provisioning | undefined;
  /** The trees the canvas keeps (cleanup's `kept`). */
  kept: (canvas: CanvasId) => readonly KeptTree[];
  /**
   * The merge state as last observed (B9b C12): your picked checkout's branch and commit, and a
   * tree's state with its merge going on or held. None: nothing observed (no `into`, no `merge`).
   */
  merges?: {
    into: (canvas: CanvasId) => { ref: string | null; oid: string | null } | null;
    of: (canvas: CanvasId, workspace: string) => WorktreeMerge;
  };
}

/**
 * The canvas's worktrees as `viewer` may see them, of `document` as it is now: every agent's (or
 * `agent`'s alone, with no kept tree), in the document's order.
 */
export function listWorktrees(
  deps: WorktreeListDeps,
  canvas: CanvasId,
  document: CanvasDocument,
  viewer: Viewer,
  agent?: string,
): WorktreeListing {
  const yours = viewer.kind === 'you';
  const owners = new Map<string, WorkspaceOwner>();
  for (const owner of workspaceOwners(document))
    for (const one of owner.agents) owners.set(one, owner);
  const bindings = deps.workspaces.bindingsOf(canvas);
  const bound = new Map(bindings.map((binding) => [binding.agent, binding]));
  const visible = yours ? undefined : visibleNodes(document, viewer.reached);
  const root = deps.projectRoot(canvas);
  const link = deps.workspaces.canvasRepository(canvas);
  const items: ListedWorktree[] = [];
  for (const node of document.nodes) {
    if (node.type !== 'agent') continue;
    if (agent !== undefined && node.id !== agent) continue;
    if (!yours && !viewer.reached.has(node.id)) continue;
    const owner = owners.get(node.id);
    if (owner === undefined) continue;
    const binding = bound.get(node.id);
    const item =
      root === undefined
        ? unplaced(node.id, owner, 'no-project')
        : binding === undefined
          ? unbound(deps, canvas, node.id, owner, link?.repository, root)
          : boundItem(deps, canvas, binding, bindings);
    if (item.group !== undefined && visible !== undefined && !visible.has(item.group)) {
      delete item.group;
    }
    // A tree's merge state, every member's the same: what the observation last read of it.
    if (item.workspace !== null && deps.merges !== undefined) {
      item.merge = deps.merges.of(canvas, item.workspace);
    }
    items.push(yours ? item : withoutYours(item));
  }
  const kept =
    !yours || agent !== undefined
      ? []
      : deps.kept(canvas).map((tree) => ({
          workspace: tree.workspace,
          owner: tree.owner,
          name: tree.name,
          branch: tree.branch,
          base: tree.base,
          state: tree.state,
          error: tree.error,
          location: deps.workspaces.worktree(tree.workspace)?.path ?? '',
          createdAt: tree.createdAt,
        }));
  return { items, kept, into: deps.merges?.into(canvas) ?? null };
}

/**
 * Who works in `agent`'s tree, as `listing` names them (so only agents its caller reaches): the
 * agent first, then the others in the document's order; just the agent with no tree of its own
 * yet; none if the listing doesn't name it. The shared-member rule, for anything that says an
 * agent's workspace to a caller (a workspace context's members and their branches too, B9a X13):
 * read through a listing, never from the bindings, so a shared tree names no member hidden from it.
 */
export function sharing(listing: WorktreeListing, agent: string): ListedWorktree[] {
  const own = listing.items.find((item) => item.agent === agent);
  if (own === undefined) return [];
  if (own.workspace === null) return [own];
  return [
    own,
    ...listing.items.filter((item) => item.agent !== agent && item.workspace === own.workspace),
  ];
}

/** An agent with no tree and no folder to work in yet: how its document would share one. */
function unplaced(agent: string, owner: WorkspaceOwner, state: ListedState): ListedWorktree {
  return {
    agent,
    ...modeOf(owner.key),
    workspace: null,
    generation: 0,
    branch: null,
    base: null,
    state,
  };
}

/** An agent with no tree bound: the shared folder, or one made as it starts (or failing to be). */
function unbound(
  deps: WorktreeListDeps,
  canvas: CanvasId,
  agent: string,
  owner: WorkspaceOwner,
  repository: string | null | undefined,
  root: string,
): ListedWorktree {
  const known = deps.provisioning?.(canvas, owner.key);
  const project = known?.project;
  if (project?.kind === 'refused')
    return { ...unplaced(agent, owner, 'error'), error: project.sentence };
  const shared = project === undefined ? repository === null : project.kind === 'not-git';
  if (shared) {
    return {
      agent,
      mode: 'shared-folder',
      workspace: null,
      generation: 0,
      branch: null,
      base: null,
      state: 'ready',
      location: root,
    };
  }
  if (known?.error !== undefined) return { ...unplaced(agent, owner, 'error'), error: known.error };
  return unplaced(agent, owner, known?.making === true ? 'creating' : 'unmade');
}

/** An agent bound to a tree: its active one, and a change waiting for your Switch, if one does. */
function boundItem(
  deps: WorktreeListDeps,
  canvas: CanvasId,
  binding: AgentBinding,
  bindings: readonly AgentBinding[],
): ListedWorktree {
  const tree = deps.workspaces.worktree(binding.workspace);
  if (tree === undefined) {
    return {
      agent: binding.agent,
      mode: 'own',
      workspace: binding.workspace,
      generation: binding.generation,
      branch: null,
      base: null,
      state: 'error',
      error: 'workspace-unknown',
    };
  }
  const item: ListedWorktree = {
    agent: binding.agent,
    ...modeOf(tree.owner),
    workspace: tree.id,
    generation: binding.generation,
    branch: branchOf(tree),
    base: { ref: tree.baseRef, oid: tree.baseOid },
    state: stateOf(tree),
    location: tree.path,
  };
  if (tree.errorCode !== null) item.error = tree.errorCode;
  const setup = deps.workspaces.setup(tree.id);
  if (setup !== undefined) {
    item.setup = {
      state: setup.state,
      command: setup.command,
      source: setup.source,
      exitCode: setup.exitCode,
    };
    // Its card, as Needs lists it: one in setup whose setup is neither done nor skipped.
    if (tree.state === 'setup' && setup.state !== 'done' && setup.state !== 'skipped') {
      item.need = setupNeedId(tree.id, setup.generation);
    }
  }
  if (binding.desired !== null) {
    // The workspace change's card is its destination's, at its latest generation (rebind.ts).
    const { owner } = binding.desired;
    const generation = Math.max(
      ...bindings.flatMap((one) => (one.desired?.owner === owner ? [one.desired.generation] : [])),
    );
    item.state = 'pending-change';
    item.need = `rebind/${encodeURIComponent(owner)}/${String(generation)}`;
  }
  return item;
}

/** Its state in use; one kept or going is no agent's, so it is said as failed. */
function stateOf(tree: WorktreeRecord): ListedState {
  switch (tree.state) {
    case 'creating':
    case 'setup':
    case 'ready':
    case 'missing':
    case 'error':
      return tree.state;
    default:
      return 'error';
  }
}

function modeOf(owner: string): Pick<ListedWorktree, 'mode' | 'group'> {
  return owner.startsWith('group/') ? { mode: 'group', group: ownerNode(owner) } : { mode: 'own' };
}

function branchOf(tree: WorktreeRecord): string {
  return tree.branchRef.startsWith('refs/heads/')
    ? tree.branchRef.slice('refs/heads/'.length)
    : tree.branchRef;
}

/** An item as a token sees it: none of what is yours alone. */
function withoutYours(item: ListedWorktree): ListedWorktree {
  const seen = { ...item };
  delete seen.need;
  delete seen.error;
  delete seen.location;
  delete seen.setup;
  if (seen.merge?.sentence !== undefined) {
    seen.merge = { ...seen.merge };
    delete seen.merge.sentence;
  }
  return seen;
}

/**
 * The nodes a token sees of a canvas, as canvas.get shows it (canvas/view.ts): the agents it
 * reaches, and the frames around them.
 */
function visibleNodes(document: CanvasDocument, reached: ReadonlySet<string>): Set<string> {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  for (const agent of reached) {
    if (byId.get(agent)?.type !== 'agent') continue;
    seen.add(agent);
    const passed = new Set<string>();
    for (let at = byId.get(agent)?.parentId; at !== undefined && !passed.has(at);) {
      passed.add(at);
      const node = byId.get(at);
      if (node?.type === 'frame') seen.add(at);
      at = node?.parentId;
    }
  }
  return seen;
}
