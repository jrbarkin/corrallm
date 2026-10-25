import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { toFile } from '../../../shared/model/file';
import { CanvasMemory } from '../../memory';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { OpFailure } from '../call';
import { Documents } from '../canvas/documents';
import { FileReviews } from '../canvas/reviews';
import { mintTrustedPath } from '../host';
import { readOnDisk } from '../store/test-store';
import { WorkspaceDirectories } from './directories';
import { WorkspacePlanner } from './planner';
import { Provisioner } from './provision';
import { WorkspaceStore } from './store';
import type { RepositoryRecord, WorktreeRecord } from './store';
import { commit, git } from './test-git';
import { CANVAS, PROFILE_ID, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * B9a: a new tree's fork source, kept within the document's write (B9a Design §3, step 1, and
 * "Grouping, ungrouping and project changes"). A spawn outside a shared group forks its source's
 * committed HEAD (never its uncommitted files), recording `forked_from`; an independent add starts
 * from the project's HEAD; a split branches from the former group's current commit. The base is
 * read by the workspace Git runner in the commit's preflight, never in its write; the creating
 * workspace, its job and its members' bindings are on disk with the document, or none of them.
 */

let t: TestWorkspaces;
let memory: CanvasMemory;
let reviews: FileReviews;
let documents: Documents;
let repository: RepositoryRecord;

const agent = (id: string, parentId?: string): CanvasNode => ({
  id,
  type: 'agent',
  ...(parentId === undefined ? {} : { parentId }),
  position: { x: parentId === undefined ? id.charCodeAt(0) * 300 : 20, y: 52 },
  data: { label: id.toUpperCase() },
});
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

function documentsOf(planner: WorkspacePlanner): Documents {
  return new Documents({
    store: t.store,
    memory,
    catalog: CATALOG,
    defaultAdapter: DEFAULT_ADAPTER,
    reviews,
    workspaces: planner,
  });
}

beforeEach(async () => {
  t = await testWorkspaces({ 'README.md': 'hello\n' });
  memory = new CanvasMemory(t.store);
  reviews = new FileReviews({ store: t.store });
  documents = documentsOf(
    new WorkspacePlanner({ workspaces: t.workspaces, provisioner: t.provisioner }),
  );
  repository = await t.repository();
  await t.workspaces.write((w) => w.bindCanvas(CANVAS, repository.id));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await memory.flush();
  await t.close();
});

/** Commits `next` as an op's change does, with a spawn's copies if any: its revision. */
async function change(
  next: CanvasDocument,
  copies?: ReadonlyMap<string, string>,
  check: () => undefined = () => undefined,
): Promise<number | undefined> {
  await documents.load(CANVAS);
  const { committed } = await documents.change(CANVAS, {
    revision: { op: 'canvas.spawnAgent', by: 'you' },
    build: () => ({ next, result: undefined, ...(copies === undefined ? {} : { copies }) }),
    check,
    committing: () => undefined,
  });
  return committed?.rev;
}

/** A workspace made for `owner`, its agents bound to it. */
async function made(owner: `${'agent' | 'group'}/${string}`, ...agents: string[]) {
  const { tree, cwd } = await t.provision(owner);
  await t.workspaces.write((w) => {
    for (const one of agents) w.bind(CANVAS, one, tree.id);
  });
  return { tree, cwd: cwd as string };
}

/** A workspace recorded `creating` for `owner` (its job never run), its agents bound to it. */
async function creating(owner: `${'agent' | 'group'}/${string}`, ...agents: string[]) {
  return t.workspaces.write((w) => {
    const { worktree } = t.provisioner.intend(w, {
      canvas: CANVAS,
      repository,
      owner,
      base: { checkout: t.app, ref: 'refs/heads/main', oid: t.base },
    });
    for (const one of agents) w.bind(CANVAS, one, worktree.id);
    return worktree;
  });
}

/** Work committed in a checkout: its new HEAD. */
function committed(cwd: string, file: string, text: string): string {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, t.env, 'add', '--', file);
  commit(cwd, t.env, `add ${file}`);
  return git(cwd, t.env, 'rev-parse', 'HEAD').trim();
}

const binding = (id: string) => t.workspaces.binding(CANVAS, id);
const treeOf = (id: string): WorktreeRecord | undefined => {
  const bound = binding(id);
  return bound === undefined ? undefined : t.workspaces.worktree(bound.workspace);
};
const createJobs = (workspace: string) =>
  t.workspaces.jobsOf(workspace).filter((job) => job.kind === 'create');

/** A directory resolver over the same records: what a start and a Switch provision through. */
function directories(): WorkspaceDirectories {
  const root = mintTrustedPath(t.app);
  return new WorkspaceDirectories({
    projects: { of: () => root, onAvailability: () => () => undefined },
    workspaces: t.workspaces,
    provisioner: t.provisioner,
    setups: { prepare: () => Promise.resolve(), reconcile: () => Promise.resolve() },
    document: async (canvas) => (await documents.load(canvas)).document,
    documentNow: (canvas) => documents.loaded(canvas)?.document,
  });
}

describe('a spawn outside a shared group', () => {
  it('forks its source’s committed HEAD, never its uncommitted files, in the spawn’s own write', async () => {
    await change(canvasOf(agent('a')));
    const a = await made('agent/a', 'a');
    const head = committed(a.cwd, 'committed.txt', 'kept\n');
    writeFileSync(path.join(a.cwd, 'README.md'), 'not committed\n');
    writeFileSync(path.join(a.cwd, 'untracked.txt'), 'not committed either\n');

    await change(canvasOf(agent('a'), agent('b')), new Map([['b', 'a']]));
    const forked = treeOf('b');
    expect(forked).toMatchObject({
      owner: 'agent/b',
      baseOid: head,
      baseCheckout: a.tree.path,
      baseRef: a.tree.branchRef,
      forkedFrom: a.tree.id,
    });
    if (forked === undefined) throw new Error('No fork');
    expect(forked.id).not.toBe(a.tree.id);
    // Its job's intent is on disk with it: the same base, the same source.
    const [job] = createJobs(forked.id);
    expect(job?.payload).toMatchObject({ base: { oid: head }, forkedFrom: a.tree.id });

    // Made once the write is on disk, from that commit's tree alone.
    if (job === undefined) throw new Error('No job');
    const tree = await t.provisioner.run(job.id);
    expect(tree.state).toBe('setup');
    expect(readFileSync(path.join(tree.path, 'committed.txt'), 'utf8')).toBe('kept\n');
    expect(readFileSync(path.join(tree.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect(existsSync(path.join(tree.path, 'untracked.txt'))).toBe(false);
    // The source is as it was: nothing of it is moved, reset or copied.
    expect(readFileSync(path.join(a.cwd, 'README.md'), 'utf8')).toBe('not committed\n');
    expect(binding('a')?.workspace).toBe(a.tree.id);
  }, 30000);

  it('forks a source still being made from the base it is made from, running no Git', async () => {
    await change(canvasOf(agent('a')));
    const a = await creating('agent/a', 'a');
    const run = vi.spyOn(t.git, 'run');
    vi.spyOn(t.provisioner, 'run').mockImplementation(() => new Promise(() => undefined));
    await change(canvasOf(agent('a'), agent('b')), new Map([['b', 'a']]));
    expect(treeOf('b')).toMatchObject({ baseOid: t.base, forkedFrom: a.id, state: 'creating' });
    expect(run).not.toHaveBeenCalled();
  });

  it('recovers from the recorded intent after a crash between the write and provisioning', async () => {
    await change(canvasOf(agent('a')));
    const a = await made('agent/a', 'a');
    const head = committed(a.cwd, 'committed.txt', 'kept\n');
    // The core stops before it runs anything after the write.
    vi.spyOn(t.provisioner, 'run').mockImplementation(() => new Promise(() => undefined));
    await change(canvasOf(agent('a'), agent('b')), new Map([['b', 'a']]));
    const onDisk = readOnDisk(t.profile, (disk) =>
      disk
        .prepare(
          `SELECT w.id, w.state, w.base_oid, w.forked_from, j.phase
             FROM agent_worktree b JOIN worktree w ON w.id = b.workspace_id
             JOIN worktree_job j ON j.workspace_id = w.id AND j.kind = 'create'
            WHERE b.canvas_id = ? AND b.agent_id = 'b'`,
        )
        .all(CANVAS),
    );
    expect(onDisk).toEqual([
      {
        id: expect.any(String) as unknown,
        state: 'creating',
        base_oid: head,
        forked_from: a.tree.id,
        phase: 'recorded',
      },
    ]);
    // The source moves on meanwhile: the fork is of the commit the spawn recorded.
    committed(a.cwd, 'later.txt', 'after the spawn\n');

    // As the next core starts: a provisioner of its own, over what is on disk.
    const restarted = new Provisioner({
      workspaces: new WorkspaceStore({ store: t.store }),
      git: t.git,
      profile: PROFILE_ID,
    });
    await restarted.reconcile();
    const tree = treeOf('b');
    expect(tree).toMatchObject({ state: 'setup', baseOid: head, forkedFrom: a.tree.id });
    if (tree === undefined) throw new Error('No fork');
    expect(readFileSync(path.join(tree.path, 'committed.txt'), 'utf8')).toBe('kept\n');
    expect(existsSync(path.join(tree.path, 'later.txt'))).toBe(false);
  }, 30000);
});

describe('an independent add', () => {
  it('records nothing in its commit, and starts from the project’s HEAD when it is made', async () => {
    await change(canvasOf(agent('a')));
    const a = await made('agent/a', 'a');
    committed(a.cwd, 'committed.txt', 'only a’s\n');
    const before = t.workspaces.worktreesOf(CANVAS).length;
    await change(canvasOf(agent('a'), agent('c')));
    expect(binding('c')).toBeUndefined();
    expect(t.workspaces.worktreesOf(CANVAS)).toHaveLength(before);

    const tree = await directories().provision(CANVAS, 'agent/c');
    expect(tree).toMatchObject({ baseOid: t.base, baseCheckout: t.app, forkedFrom: null });
    expect(binding('c')?.workspace).toBe(tree.id);
    expect(existsSync(path.join(tree.path, 'committed.txt'))).toBe(false);
  }, 30000);
});

describe('a split', () => {
  it('branches a materialized member from the former group’s current commit when its tree is made', async () => {
    await change(canvasOf(frame('f'), agent('a', 'f'), agent('b', 'f')));
    const group = await made('group/f', 'a', 'b');
    committed(group.cwd, 'group.txt', 'the group’s\n');
    await change(canvasOf(frame('f'), agent('a', 'f'), agent('b')));
    // Its move waits for you: no tree is made for it yet, and it works where it did.
    expect(binding('b')).toMatchObject({ workspace: group.tree.id, desired: { owner: 'agent/b' } });
    expect(t.workspaces.activeWorktree(CANVAS, repository.id, 'agent/b')).toBeUndefined();
    // It goes on working there until it switches: the split takes that work with it.
    const current = committed(group.cwd, 'since.txt', 'b’s, before Switch\n');

    // Switch's destination (and any start's) is provisioned through the resolver.
    const tree = await directories().provision(CANVAS, 'agent/b');
    expect(tree).toMatchObject({
      owner: 'agent/b',
      baseOid: current,
      baseCheckout: group.tree.path,
      forkedFrom: group.tree.id,
    });
    expect(readFileSync(path.join(tree.path, 'since.txt'), 'utf8')).toBe('b’s, before Switch\n');
    // Its active binding is still the group's until you switch it.
    expect(binding('b')).toMatchObject({ workspace: group.tree.id, desired: { owner: 'agent/b' } });
  }, 30000);

  it('records a member moved out of a tree still being made with that tree’s base, in its commit', async () => {
    await change(canvasOf(frame('f'), agent('a', 'f'), agent('b', 'f')));
    const group = await creating('group/f', 'a', 'b');
    vi.spyOn(t.provisioner, 'run').mockImplementation(() => new Promise(() => undefined));
    await change(canvasOf(frame('f'), agent('a', 'f'), agent('b')));
    expect(treeOf('b')).toMatchObject({
      owner: 'agent/b',
      state: 'creating',
      baseOid: t.base,
      forkedFrom: group.id,
    });
    expect(binding('b')?.desired).toBeNull();
    // The group keeps its tree.
    expect(binding('a')?.workspace).toBe(group.id);
    expect(t.workspaces.worktree(group.id)?.state).toBe('creating');
  });
});

describe('every commit path', () => {
  it('records a fork through a file’s Apply and a discard’s revert, as through an op’s change', async () => {
    const file = path.join(t.root, 'team.corral');
    const grouped = canvasOf(frame('f'), agent('a', 'f'), agent('b', 'f'));
    const split = canvasOf(frame('f'), agent('a', 'f'), agent('b'));
    await writeFile(file, toFile(grouped));
    await memory.setFile(CANVAS, mintTrustedPath(file));
    const loaded = documents;
    await loaded.load(CANVAS);
    const group = await creating('group/f', 'a', 'b');
    vi.spyOn(t.provisioner, 'run').mockImplementation(() => new Promise(() => undefined));

    // On disk, b is out of the group: Apply records its tree, forked from the group's.
    await writeFile(file, toFile(split));
    await loaded.review(CANVAS);
    const review = reviews.open(CANVAS);
    if (review === undefined) throw new Error('No review');
    const turn = { signal: new AbortController().signal, noReturn: () => undefined };
    await loaded.applyFile(CANVAS, review, 'you', turn);
    const applied = treeOf('b');
    expect(applied).toMatchObject({ owner: 'agent/b', forkedFrom: group.id, baseOid: t.base });

    // Back into the group, then discarded to the file: the revert records another fork.
    await change(grouped);
    expect(binding('b')?.workspace).toBe(group.id);
    await loaded.revert(CANVAS, { op: 'canvas.close', by: 'you' });
    const reverted = treeOf('b');
    expect(reverted).toMatchObject({ owner: 'agent/b', forkedFrom: group.id, baseOid: t.base });
    expect(reverted?.id).not.toBe(applied?.id);
  });
});

describe('a commit that doesn’t happen', () => {
  async function spawnable() {
    await change(canvasOf(agent('a')));
    return made('agent/a', 'a');
  }
  const SPAWNED = canvasOf(agent('a'), agent('b'));
  const COPIES = new Map([['b', 'a']]);

  it('records nothing when its checks refuse it after the preflight read the base', async () => {
    await spawnable();
    const trees = t.workspaces.worktreesOf(CANVAS);
    await expect(
      change(SPAWNED, COPIES, () => {
        throw new OpFailure('refused', 'Not that.');
      }),
    ).rejects.toThrow('Not that.');
    expect(t.workspaces.worktreesOf(CANVAS)).toEqual(trees);
    expect(binding('b')).toBeUndefined();
    expect(t.workspaces.openJobs()).toEqual([]);
  }, 30000);

  it('is refused, recording nothing, while its source’s committed HEAD can’t be read', async () => {
    const a = await spawnable();
    const trees = t.workspaces.worktreesOf(CANVAS);
    rmSync(a.cwd, { recursive: true, force: true });
    const refused = change(SPAWNED, COPIES);
    await expect(refused).rejects.toBeInstanceOf(OpFailure);
    await expect(refused).rejects.toThrow(/can’t be read/);
    expect(documents.live(CANVAS).document.nodes.map(({ id }) => id)).toEqual(['a']);
    expect(t.workspaces.worktreesOf(CANVAS)).toEqual(trees);
    expect(binding('b')).toBeUndefined();
  }, 30000);

  it('keeps nothing of a failed write, and records the fork once when it is retried', async () => {
    await spawnable();
    vi.spyOn(t.provisioner, 'run').mockImplementation(() => new Promise(() => undefined));
    const bind = vi.spyOn(t.workspaces, 'bind').mockImplementationOnce(() => {
      throw new Error('The disk is full.');
    });
    await expect(change(SPAWNED, COPIES)).rejects.toThrow(/couldn’t be written/);
    expect(t.workspaces.activeWorktree(CANVAS, repository.id, 'agent/b')).toBeUndefined();
    expect(binding('b')).toBeUndefined();
    expect(t.workspaces.openJobs()).toEqual([]);
    bind.mockRestore();

    await change(SPAWNED, COPIES);
    const forks = t.workspaces.worktreesOf(CANVAS).filter((tree) => tree.owner === 'agent/b');
    expect(forks).toHaveLength(1);
    expect(binding('b')?.workspace).toBe(forks[0]?.id);
    expect(t.workspaces.openJobs()).toHaveLength(1);
  }, 30000);
});
