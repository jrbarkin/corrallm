import type { CanvasId } from '../canvas';
import type { CanvasDocument, CanvasNode } from './canvas';
import { diffRows, toRows } from './rows';
import type { Row } from './rows';

/** Desired sharing, not a filesystem name or a durable workspace id (B9a Design §2). */
export type WorkspaceOwnerKey = `${'agent' | 'group'}/${string}`;
export interface WorkspaceOwner {
  key: WorkspaceOwnerKey;
  kind: 'agent' | 'group';
  node: string;
  /** Members in document order, including the agent heading a group. */
  agents: readonly string[];
}

/** Facts supplied by the core; the pure planner discovers no repository and mints no ids. */
export interface RepositoryRevision {
  id: string;
  generation: number;
  ref: string | null;
  revision: string;
}
export interface Workspace {
  id: string;
  canvas: CanvasId;
  repository: string;
  owner: WorkspaceOwnerKey;
  /** Null is unknown, never permission to substitute the project's revision. */
  revision: string | null;
  /** Retained historical trees are neither destinations nor automatic cleanup candidates. */
  active: boolean;
}
export interface Binding {
  agent: string;
  workspace: string;
  generation: number;
}
export type WorkspaceSource =
  | { kind: 'project'; revision: string }
  | { kind: 'workspace'; workspace: string; revision: string | null };
export interface PlannedWorkspace {
  owner: WorkspaceOwner;
  target: { kind: 'reuse'; workspace: string } | { kind: 'create'; source: WorkspaceSource };
  bindings: readonly { agent: string; previous: Binding | null }[];
}
export interface BindingPlan {
  canvas: CanvasId;
  repository: RepositoryRevision;
  components: readonly PlannedWorkspace[];
  removed: readonly { agent: string; binding: Binding | null }[];
  /** No longer destinations. This describes releases, never authorizes removal or discarding. */
  released: readonly string[];
  changes: readonly { key: string; before: Row | null; after: Row | null }[];
}
export interface BindingPlanInput {
  before: CanvasDocument;
  after: CanvasDocument;
  repository: RepositoryRevision;
  bindings: readonly Binding[];
  workspaces: readonly Workspace[];
  /** New agent → copied agent, as in Built.copies. */
  copies?: ReadonlyMap<string, string>;
}

/**
 * The outermost container owns the tree; nested groups do not create nested checkouts. Validate
 * the whole hierarchy, including empty frames, so a bad parent never becomes an independent root.
 */
export function workspaceOwners(document: CanvasDocument): WorkspaceOwner[] {
  const nodes = unique(document.nodes, (node) => node.id, 'node');
  const parents = new Set(document.nodes.flatMap((node) => node.parentId ?? []));
  const roots = new Map<string, CanvasNode>();
  for (const node of document.nodes) {
    const chain: CanvasNode[] = [];
    const seen = new Set<string>();
    let current = node;
    while (!roots.has(current.id)) {
      if (seen.has(current.id)) throw new TypeError(`Cycle in workspace parents at ${current.id}.`);
      seen.add(current.id);
      chain.push(current);
      if (current.parentId === undefined) {
        roots.set(current.id, current);
        break;
      }
      const parent = nodes.get(current.parentId);
      if (!parent) throw new TypeError(`Missing workspace parent ${current.parentId}.`);
      current = parent;
    }
    const root = roots.get(current.id);
    if (!root) throw new TypeError('No workspace root.');
    for (const member of chain) roots.set(member.id, root);
  }
  const owners = new Map<string, WorkspaceOwner & { agents: string[] }>();
  for (const node of document.nodes) {
    if (node.type !== 'agent') continue;
    const root = roots.get(node.id);
    if (!root) throw new TypeError(`No workspace root for ${node.id}.`);
    let owner = owners.get(root.id);
    if (!owner) {
      const kind = root.type === 'frame' || parents.has(root.id) ? 'group' : 'agent';
      owner = { key: `${kind}/${encodeURIComponent(root.id)}`, kind, node: root.id, agents: [] };
      owners.set(root.id, owner);
    }
    owner.agents.push(node.id);
  }
  return [...owners.values()];
}

export function workspaceOwner(document: CanvasDocument, agent: string): WorkspaceOwner {
  const owner = workspaceOwners(document).find((owner) => owner.agents.includes(agent));
  if (!owner) throw new TypeError(`There is no agent ${agent} to assign a workspace.`);
  return owner;
}

/**
 * Describes destinations and committed fork sources only. It neither decides whether a rebind
 * needs consent nor applies it: the core supplies observations, checks safety and keeps old work.
 */
export function bindingPlan(input: BindingPlanInput): BindingPlan {
  const { before, after, repository } = input;
  if (before.id !== after.id) throw new TypeError('A binding plan is for one canvas.');
  workspaceOwners(before);
  const owners = workspaceOwners(after);
  const workspaces = unique(input.workspaces, (tree) => tree.id, 'workspace');
  const bindings = unique(input.bindings, (binding) => binding.agent, 'binding');
  for (const tree of workspaces.values()) {
    if (tree.canvas !== after.id) throw new TypeError(`Workspace ${tree.id} is on another canvas.`);
  }
  for (const binding of bindings.values()) {
    if (!workspaces.has(binding.workspace))
      throw new TypeError(`Missing workspace ${binding.workspace} for ${binding.agent}.`);
  }
  checkCopies(before, after, input.copies);
  const active = [...workspaces.values()].filter(
    (tree) => tree.active && tree.repository === repository.id,
  );
  const byRoot = unique(
    active,
    (tree) => tree.owner.slice(tree.owner.indexOf('/') + 1),
    'workspace owner',
  );
  const reserved = new Map<string, WorkspaceOwnerKey>();
  for (const owner of owners) {
    const tree = byRoot.get(encodeURIComponent(owner.node));
    if (tree) reserved.set(tree.id, owner.key);
  }
  const surviving = new Set(owners.flatMap((owner) => owner.agents));
  const used = new Set<string>();
  const oldTree = (agent: string) => {
    const id = bindings.get(agent)?.workspace;
    const tree = id === undefined ? undefined : workspaces.get(id);
    return tree?.repository === repository.id ? tree : undefined;
  };
  const components = owners.map((owner): PlannedWorkspace => {
    const members = new Set(owner.agents);
    const reusable = (tree: Workspace | undefined): tree is Workspace =>
      tree !== undefined &&
      tree.active &&
      !used.has(tree.id) &&
      (!reserved.has(tree.id) || reserved.get(tree.id) === owner.key) &&
      (reserved.get(tree.id) === owner.key ||
        input.bindings.every(
          (binding) =>
            binding.workspace !== tree.id ||
            !surviving.has(binding.agent) ||
            members.has(binding.agent),
        ));
    const exact = byRoot.get(encodeURIComponent(owner.node));
    const candidates = [exact, oldTree(owner.node), ...owner.agents.map(oldTree)];
    const target = candidates.find(reusable);
    if (target) used.add(target.id);
    let source: WorkspaceSource = { kind: 'project', revision: repository.revision };
    if (!target) {
      for (const agent of owner.agents) {
        let from = agent;
        while (input.copies?.has(from)) from = input.copies.get(from) ?? from;
        const tree = oldTree(from);
        if (tree) {
          source = { kind: 'workspace', workspace: tree.id, revision: tree.revision };
          break;
        }
      }
    }
    return {
      owner,
      target: target ? { kind: 'reuse', workspace: target.id } : { kind: 'create', source },
      bindings: owner.agents.map((agent) => ({ agent, previous: bindings.get(agent) ?? null })),
    };
  });
  const previousRows = toRows(before);
  const next = diffRows(previousRows, after, before);
  return {
    canvas: after.id,
    repository,
    components,
    removed: before.nodes
      .filter((node) => node.type === 'agent' && !surviving.has(node.id))
      .map(({ id }) => ({ agent: id, binding: bindings.get(id) ?? null })),
    released: input.workspaces
      .filter((tree) => tree.active && !used.has(tree.id))
      .map((tree) => tree.id)
      .sort(),
    changes: [...next.changed, ...next.renumbered]
      .sort()
      .map((key) => ({ key, before: previousRows[key] ?? null, after: next.rows[key] ?? null })),
  };
}

/** Opaque observations: only the core may obtain and verify these facts (no Git/OS here). */
export interface WorkspaceObservation {
  workspace: string;
  generation: number;
  /** Opaque identity observed by the caller; this module does not verify it. */
  identity: string | null;
  branch: string | null;
  head: string | null;
  /** The caller's fingerprint of dirty/untracked state; null means it could not be inspected. */
  status: string | null;
  merged: boolean | null;
  sessions: readonly { agent: string; id: string; generation: number }[];
  setup: { id: string; generation: number; state: string } | null;
}

/**
 * Deterministic comparison text, not an approval, cryptographic digest or trust proof. Covers
 * affected membership/bindings and observations; incidental labels/coordinates do not stale it.
 */
export function rebindFingerprint(
  plan: BindingPlan,
  observations: readonly WorkspaceObservation[],
): string {
  const components = plan.components.filter((component) =>
    component.bindings.some(
      ({ previous }) =>
        previous !== null &&
        (component.target.kind === 'create' || previous.workspace !== component.target.workspace),
    ),
  );
  return fingerprint({
    canvas: plan.canvas,
    repository: plan.repository,
    components: components.map(componentState).sort(compare),
    observations: evidence(components.flatMap(workspaceIds), observations),
  });
}

/** Captures the whole proposed document delta, not just the removed agents' labels or ids. */
export function deletionFingerprint(
  plan: BindingPlan,
  observations: readonly WorkspaceObservation[],
  revisions: Readonly<Record<string, number>> = {},
): string {
  const ids = [
    ...plan.released,
    ...plan.removed.flatMap(({ binding }) => (binding ? [binding.workspace] : [])),
  ];
  return fingerprint({
    canvas: plan.canvas,
    repository: plan.repository,
    removed: [...plan.removed].sort(compare),
    released: plan.released,
    components: plan.components.map(componentState).sort(compare),
    changes: plan.changes.map((change) => ({ ...change, rev: revisions[change.key] ?? 0 })),
    observations: evidence(ids, observations),
  });
}

function workspaceIds(component: PlannedWorkspace): string[] {
  const target = component.target;
  return [
    ...(target.kind === 'reuse'
      ? [target.workspace]
      : target.source.kind === 'workspace'
        ? [target.source.workspace]
        : []),
    ...component.bindings.flatMap(({ previous }) => (previous ? [previous.workspace] : [])),
  ];
}
function componentState(component: PlannedWorkspace) {
  return {
    owner: { ...component.owner, agents: [...component.owner.agents].sort() },
    target: component.target,
    bindings: [...component.bindings].sort(compare),
  };
}
function evidence(ids: readonly string[], observations: readonly WorkspaceObservation[]) {
  const byId = unique(observations, (observation) => observation.workspace, 'observation');
  return [...new Set(ids)].sort().map((id) => {
    const observation = byId.get(id);
    if (!observation) throw new TypeError(`Missing workspace observation ${id}.`);
    return { ...observation, sessions: [...observation.sessions].sort(compare) };
  });
}
function unique<T>(values: readonly T[], key: (value: T) => string, kind: string): Map<string, T> {
  const found = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (found.has(id)) throw new TypeError(`Duplicate ${kind} ${id}.`);
    found.set(id, value);
  }
  return found;
}
function checkCopies(
  before: CanvasDocument,
  after: CanvasDocument,
  copies: ReadonlyMap<string, string> | undefined,
): void {
  if (!copies) return;
  const was = new Set(before.nodes.filter((node) => node.type === 'agent').map((node) => node.id));
  const now = new Set(after.nodes.filter((node) => node.type === 'agent').map((node) => node.id));
  for (const [to, source] of copies) {
    if (!now.has(to) || was.has(to) || (!was.has(source) && !now.has(source)))
      throw new TypeError(`Invalid workspace copy ${to} from ${source}.`);
    const seen = new Set<string>([to]);
    let from: string | undefined = source;
    while (from !== undefined) {
      if (seen.has(from)) throw new TypeError(`Cycle in workspace copies at ${from}.`);
      seen.add(from);
      from = copies.get(from);
    }
  }
}
function compare(a: unknown, b: unknown): number {
  const left = fingerprint(a),
    right = fingerprint(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
function fingerprint(value: unknown): string {
  const canonical = (one: unknown): unknown => {
    if (Array.isArray(one)) return one.map(canonical);
    if (one && typeof one === 'object')
      return Object.fromEntries(
        Object.entries(one)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return one;
  };
  return JSON.stringify(canonical(value));
}
