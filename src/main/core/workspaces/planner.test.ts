import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { CanvasMemory } from '../../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { FakeConnector } from '../../sessions/fake';
import { OpFailure } from '../call';
import { Documents } from '../canvas/documents';
import { FileReviews } from '../canvas/reviews';
import { createCore } from '../core';
import type { Core } from '../core';
import { mintTrustedPath } from '../host';
import type { Connection } from '../store/sqlite';
import type { Store } from '../store/store';
import { keepCanvases, onDisk, openTestStore } from '../store/test-store';
import { CALLERS, NO_DESKTOP } from '../test-registry';
import { WorkspacePlanner } from './planner';
import { WorkspaceStore } from './store';
import type { NewRepository, NewWorktree, WorktreeRecord, WorktreeState } from './store';
import type { TreeState } from './cleanup';

/*
 * B9a C6: who works where follows every change to a canvas's document, at its commit seam (an op's
 * change, a batch, a file's Apply, a discard's revert), in the same write: a new member joins its
 * group's tree, a materialized agent's move waits for you with its active binding kept, an agent
 * moved back has nothing waiting, a tree no one works in is kept; the loss preflight runs before
 * the point of no return; a project change keeps every old tree.
 */

const CANVAS = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d' as CanvasId;
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const OTHER_REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e71';
const A = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';
const B = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c52';
const OID = 'a'.repeat(40);

const REPO: NewRepository = {
  id: REPOSITORY,
  pickedRoot: '/work/app',
  realRoot: '/work/app',
  commonDir: '/work/app/.git',
  identity: 'repository identity',
  rootKind: 'project',
  ownedRoot: '/work/app/.corral/worktrees/profile',
};

function tree(id: string, owner: string): NewWorktree {
  return {
    id,
    canvas: CANVAS,
    repository: REPOSITORY,
    owner: owner as NewWorktree['owner'],
    path: `/work/app/.corral/worktrees/profile/${id}`,
    branchRef: `refs/heads/corrallm/profile/${id}`,
    baseCheckout: '/work/app',
    baseRef: 'refs/heads/main',
    baseOid: OID,
    forkedFrom: null,
  };
}

function agent(id: string, parentId?: string): CanvasNode {
  return {
    id,
    type: 'agent',
    ...(parentId === undefined ? {} : { parentId }),
    position: { x: parentId === undefined ? id.charCodeAt(0) * 300 : 20, y: 52 },
    data: { label: id.toUpperCase() },
  };
}
const frame = (id: string): CanvasNode => ({
  id,
  type: 'frame',
  position: { x: 0, y: 400 },
  data: { label: 'Team' },
});
const canvasOf = (...nodes: CanvasNode[]): CanvasDocument => ({
  id: CANVAS,
  arrange: false,
  nodes,
  links: [],
});
/** Two lone agents, and the same two grouped in a frame. */
const LONE = canvasOf(agent('a'), agent('b'));
const GROUPED = canvasOf(frame('f'), agent('a', 'f'), agent('b', 'f'));

let profile: string;
let store: Store;
let memory: CanvasMemory;
let workspaces: WorkspaceStore;
let documents: Documents;
let reviews: FileReviews;
/** Why new work for each agent waits now, as the mutation gate would say it. */
let restoring: Map<string, string>;
let disk: Connection;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-planner-'));
  store = await openTestStore(profile);
  disk = onDisk(profile);
  memory = new CanvasMemory(store);
  workspaces = new WorkspaceStore({ store });
  reviews = new FileReviews({ store });
  restoring = new Map();
  documents = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
    reviews,
    workspaces: new WorkspacePlanner({
      workspaces,
      holding: (_canvas, agent) => Promise.resolve(restoring.get(agent)),
    }),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  disk.close();
  await memory.flush();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

/** Commits `next` as an op's change does (a doc op's, a batch's): its revision. */
async function commit(next: CanvasDocument): Promise<number | undefined> {
  await documents.load(CANVAS);
  const { committed } = await documents.change(CANVAS, {
    revision: { op: 'canvas.group', by: 'you' },
    build: () => ({ next, result: undefined }),
    check: () => undefined,
    committing: () => undefined,
  });
  return committed?.rev;
}

/** The canvas's project is the repository, with `trees` (id, owner, state) and `bound` agents. */
async function seed(
  trees: readonly [string, string, WorktreeState][],
  bound: Readonly<Record<string, string>>,
): Promise<void> {
  await workspaces.write((w) => {
    w.addRepository(REPO);
    w.bindCanvas(CANVAS, REPOSITORY);
    for (const [id, owner, state] of trees) {
      w.createWorktree(tree(id, owner));
      if (state !== 'creating') w.transition(id, { from: 'creating', to: 'setup' });
      if (state === 'ready') w.transition(id, { from: 'setup', to: 'ready' });
    }
    for (const [agentId, workspace] of Object.entries(bound)) w.bind(CANVAS, agentId, workspace);
  });
}

/** Two lone agents' materialized trees, each bound to its own. */
async function twoTrees(states: [WorktreeState, WorktreeState] = ['ready', 'ready']) {
  await commit(LONE);
  await seed(
    [
      [A, 'agent/a', states[0]],
      [B, 'agent/b', states[1]],
    ],
    { a: A, b: B },
  );
}

const binding = (agentId: string) => workspaces.binding(CANVAS, agentId);
const owner = (id: string) => workspaces.worktree(id)?.owner;
const state = (id: string) => workspaces.worktree(id)?.state;

describe('the document seam', () => {
  it('keeps the first member’s tree as a new group’s, and holds the other’s move for you, its active binding kept', async () => {
    await twoTrees();
    const [a, b] = [binding('a'), binding('b')];
    await commit(GROUPED);
    expect(owner(A)).toBe('group/f');
    expect(binding('a')).toEqual(a);
    // Its move waits: the active binding (and its session) stays in its own tree meanwhile.
    expect(binding('b')).toMatchObject({
      workspace: B,
      generation: b?.generation,
      desired: { owner: 'group/f' },
    });
    expect(binding('b')?.desired?.generation).toBeGreaterThan(b?.generation ?? Infinity);
    expect(state(B)).toBe('ready');
    // A commit that changes no membership changes nothing of it.
    const desired = binding('b')?.desired;
    await commit({
      ...GROUPED,
      nodes: GROUPED.nodes.map((node) =>
        node.id === 'a' ? { ...node, data: { ...node.data, label: 'Lead' } } : node,
      ),
    });
    expect(binding('b')?.desired).toEqual(desired);

    // Moved back out: nothing waits any more.
    await commit(canvasOf(frame('f'), agent('a', 'f'), agent('b')));
    expect(binding('b')).toMatchObject({ workspace: B, generation: b?.generation, desired: null });
  });

  it('binds a new member with no tree to its group’s at once, at a generation of its own', async () => {
    await twoTrees();
    await commit(GROUPED);
    const a = binding('a');
    await commit(canvasOf(frame('f'), agent('a', 'f'), agent('b', 'f'), agent('c', 'f')));
    expect(binding('c')).toMatchObject({ workspace: A, desired: null });
    expect(binding('c')?.generation).toBeGreaterThan(a?.generation ?? Infinity);
    expect(binding('a')).toEqual(a);
  });

  it('moves an agent whose tree is still being made at once, and keeps the tree no one works in', async () => {
    await twoTrees(['ready', 'creating']);
    await commit(GROUPED);
    expect(binding('b')).toMatchObject({ workspace: A, desired: null });
    expect(state(B)).toBe('retained');
  });

  it('keeps a removed agent’s tree, unbound, its work never removed', async () => {
    await twoTrees();
    await commit(canvasOf(agent('a')));
    expect(binding('b')).toBeUndefined();
    expect(state(B)).toBe('retained');
    expect(workspaces.worktree(B)?.path).toBe(tree(B, 'agent/b').path);
    expect(binding('a')?.workspace).toBe(A);
  });

  it('runs the loss preflight before the point of no return: a change of a tree being restored applies nothing', async () => {
    await twoTrees();
    const rev = documents.live(CANVAS).rev;
    restoring.set('b', 'Its files are being restored.');
    const refused = commit(canvasOf(agent('a')));
    await expect(refused).rejects.toBeInstanceOf(OpFailure);
    await expect(refused).rejects.toThrow(/being restored/);
    expect(documents.live(CANVAS).rev).toBe(rev);
    expect(binding('b')?.workspace).toBe(B);
    expect(state(B)).toBe('ready');
    restoring.clear();
    await commit(canvasOf(agent('a')));
    expect(state(B)).toBe('retained');
  });

  it('keeps who works where with the document, or neither: a failed write leaves both as they were', async () => {
    await twoTrees();
    vi.spyOn(workspaces, 'plan').mockImplementation(() => {
      throw new Error('The disk is full.');
    });
    await expect(commit(GROUPED)).rejects.toThrow(/couldn’t be written/);
    expect(documents.live(CANVAS).document).toEqual(LONE);
    expect(owner(A)).toBe('agent/a');
    expect(binding('b')?.desired).toBeNull();
  });

  it('plans a file’s Apply and a discard’s revert as an op’s change: neither bypasses the seam', async () => {
    const file = path.join(profile, 'team.corral');
    await writeFile(file, toFile(LONE));
    await memory.setFile(CANVAS, mintTrustedPath(file));
    await documents.load(CANVAS);
    await seed(
      [
        [A, 'agent/a', 'ready'],
        [B, 'agent/b', 'ready'],
      ],
      { a: A, b: B },
    );
    // The file is grouped on disk: Apply makes it the canvas's change, and b's move waits.
    await writeFile(file, toFile(GROUPED));
    await documents.review(CANVAS);
    const review = reviews.open(CANVAS);
    if (!review) throw new Error('No review');
    restoring.set('b', 'Its files are being restored.');
    const turn = { signal: new AbortController().signal, noReturn: () => undefined };
    await expect(documents.applyFile(CANVAS, review, 'you', turn)).rejects.toThrow(
      /being restored/,
    );
    expect(documents.live(CANVAS).document).toEqual(LONE);
    restoring.clear();
    await documents.applyFile(CANVAS, review, 'you', turn);
    expect(owner(A)).toBe('group/f');
    expect(binding('b')).toMatchObject({ workspace: B, desired: { owner: 'group/f' } });

    // An edit moves b back out; a discard reverts to the file, grouped again: its move waits again.
    await commit(canvasOf(frame('f'), agent('a', 'f'), agent('b')));
    expect(binding('b')?.desired).toBeNull();
    await documents.revert(CANVAS, { op: 'canvas.close', by: 'you' });
    expect(binding('b')).toMatchObject({ workspace: B, desired: { owner: 'group/f' } });
  });
});

describe('trees left with no agent (B9a C7)', () => {
  /** What each tree holds, as the cleanup would assess it: clean and merged, or with work. */
  const held = (workspace: string, work: boolean): TreeState => ({
    workspace,
    head: OID,
    tip: OID,
    changed: work ? 1 : 0,
    untracked: 0,
    paths: work ? ['README.md'] : [],
    merged: true,
    writers: [],
    setup: false,
    status: work ? 'dirty' : 'clean',
  });

  it('removes a safe one with its last agent on a file’s Apply and a discard, keeping one with work', async () => {
    const removed: string[] = [];
    const cleanup = {
      assess: (tree: WorktreeRecord) => Promise.resolve(held(tree.id, tree.id === B)),
      intend: (w: WorkspaceStore, workspace: string) => {
        w.markRemoving(workspace);
      },
      remove: (workspace: string) => {
        removed.push(workspace);
        return Promise.resolve('removed' as const);
      },
    };
    const cleaning = new Documents({
      store,
      memory,
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
      reviews,
      workspaces: new WorkspacePlanner({ workspaces, cleanup }),
    });
    const file = path.join(profile, 'team.corral');
    await writeFile(file, toFile(LONE));
    await memory.setFile(CANVAS, mintTrustedPath(file));
    await cleaning.load(CANVAS);
    await seed(
      [
        [A, 'agent/a', 'ready'],
        [B, 'agent/b', 'ready'],
      ],
      { a: A, b: B },
    );
    // On disk, both agents are gone: Apply removes them, a's clean tree with it, b's kept.
    await writeFile(file, toFile(canvasOf()));
    await cleaning.review(CANVAS);
    const review = reviews.open(CANVAS);
    if (!review) throw new Error('No review');
    const turn = { signal: new AbortController().signal, noReturn: () => undefined };
    await cleaning.applyFile(CANVAS, review, 'you', turn);
    expect(workspaces.worktree(A)?.state).toBe('removing');
    expect(workspaces.worktree(B)?.state).toBe('retained');
    expect(removed).toEqual([A]);
  });
});

describe('a project change', () => {
  it('keeps every old tree, unbinds their agents, and moves the project on', async () => {
    await twoTrees();
    await commit(GROUPED);
    const planner = new WorkspacePlanner({ workspaces });
    const before = workspaces.canvasRepository(CANVAS)?.generation ?? 0;
    await workspaces.write((w) =>
      w.addRepository({
        ...REPO,
        id: OTHER_REPOSITORY,
        realRoot: '/work/other',
        pickedRoot: '/work/other',
        commonDir: '/work/other/.git',
        ownedRoot: '/work/other/.corral/worktrees/profile',
      }),
    );
    await planner.projectChosen(CANVAS, OTHER_REPOSITORY);
    expect([state(A), state(B)]).toEqual(['retained', 'retained']);
    expect(workspaces.bindingsOf(CANVAS)).toEqual([]);
    expect(workspaces.canvasRepository(CANVAS)).toEqual({
      canvas: CANVAS,
      repository: OTHER_REPOSITORY,
      generation: before + 1,
    });
    // Its old records stay: nothing is forgotten because the repository is another.
    expect(
      workspaces
        .worktreesOf(CANVAS)
        .map(({ id }) => id)
        .sort(),
    ).toEqual([A, B].sort());
    // A change after it plans for the new repository: nothing of the old trees is reused.
    await commit(canvasOf(agent('a'), agent('b')));
    expect(workspaces.bindingsOf(CANVAS)).toEqual([]);
  });

  it('changes nothing for a canvas with no workspace records', async () => {
    await commit(LONE);
    await new WorkspacePlanner({ workspaces }).projectChosen(CANVAS, undefined);
    expect(workspaces.canvasRepository(CANVAS)).toBeUndefined();
  });
});

describe('through the core', () => {
  let core: Core | undefined;
  afterEach(async () => {
    await core?.close().catch(() => undefined);
    core = undefined;
  });

  it('holds a materialized member’s move from a batch for you, in the batch’s one commit', async () => {
    // Its own profile, kept as the app would, its workspaces seeded before the core opens it.
    await memory.flush();
    await store.close();
    disk.close();
    const project = path.join(profile, 'project');
    await mkdir(project);
    const file = path.join(profile, 'team.corral');
    await writeFile(file, toFile(LONE));
    await keepCanvases(profile, { [CANVAS]: { file, project } });
    store = await openTestStore(profile);
    memory = new CanvasMemory(store);
    workspaces = new WorkspaceStore({ store });
    await commitLoaded();
    await store.close();
    core = await createCore(
      {
        profile,
        app: { name: 'corrallm', version: '9.8.7' },
        check: true,
        distribution: 'local',
        sessions: {
          connectors: { 'claude-code.terminal': new FakeConnector() },
          environment: () => Promise.resolve({}),
        },
        watchFolder: () => ({ close: () => undefined }),
      },
      NO_DESKTOP,
    );
    await core.engines.open(CANVAS);
    const result = await core.call(
      'canvas.batch',
      { canvas: CANVAS, ops: [{ op: 'canvas.group', args: { nodes: ['a', 'b'], kind: 'frame' } }] },
      CALLERS.you,
    );
    expect(result.ok).toBe(true);
    disk = onDisk(profile);
    const rows = disk
      .prepare(
        'SELECT agent_id, workspace_id, desired_owner_key FROM agent_worktree ORDER BY agent_id',
      )
      .all();
    expect(rows).toEqual([
      { agent_id: 'a', workspace_id: A, desired_owner_key: null },
      {
        agent_id: 'b',
        workspace_id: B,
        desired_owner_key: expect.stringMatching(/^group\//) as unknown,
      },
    ]);
    // Reopened for afterEach's close.
    store = await openTestStore(profile);
    memory = new CanvasMemory(store);
  });
});

/** Seeds two materialized trees for the canvas in the core's database, its document loaded first. */
async function commitLoaded(): Promise<void> {
  const loaded = new Documents({
    store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
  });
  await loaded.load(CANVAS);
  await seed(
    [
      [A, 'agent/a', 'ready'],
      [B, 'agent/b', 'ready'],
    ],
    { a: A, b: B },
  );
  await memory.flush();
}
