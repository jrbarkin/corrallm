import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { CanvasMemory } from '../../memory';
import { RunJournal } from '../../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { Documents } from '../canvas/documents';
import { commitDocument } from '../canvas/test-documents';
import { unopened } from '../store/store';
import type { Store } from '../store/store';
import { onDisk, openTestStore, refuseWrites } from '../store/test-store';
import type { Connection } from '../store/sqlite';
import { WorkspaceStore, WorkspaceStoreError } from './store';
import type { NewRepository, NewWorktree } from './store';

/*
 * The workspaces the core keeps of each canvas (schema 3): repositories, canvases' repositories,
 * workspaces and their states, agents' bindings, jobs, setups and repositories' setup commands,
 * each written within a write, its own or another store's.
 */

const CANVAS = '11111111-1111-4111-8111-111111111111' as CanvasId;
const OTHER = '22222222-2222-4222-8222-222222222222' as CanvasId;
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const W1 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c51';
const W2 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c52';
const W3 = '9d1c5a0e-0f4e-4c11-8a51-0b1f2e3d4c53';
const J1 = 'c0ffee00-0000-4000-8000-000000000001';
const J2 = 'c0ffee00-0000-4000-8000-000000000002';
const J3 = 'c0ffee00-0000-4000-8000-000000000003';
const OID = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);

let profile: string;
let store: Store;
let memory: CanvasMemory;
let now: number;
let workspaces: WorkspaceStore;
/** What is on disk, read by a connection of its own. */
let reader: Connection;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-workspaces-'));
  store = await openTestStore(profile);
  reader = onDisk(profile);
  memory = new CanvasMemory(store);
  now = 1000;
  workspaces = new WorkspaceStore({ store, now: () => now });
  await store.write(() => {
    memory.ensure(CANVAS);
    memory.ensure(OTHER);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  reader.close();
  await store.close();
  await rm(profile, { recursive: true, force: true });
});

const REPO: NewRepository = {
  id: REPOSITORY,
  pickedRoot: '/work/app',
  realRoot: '/work/app',
  commonDir: '/work/app/.git',
  identity: 'repository identity',
  rootKind: 'project',
  ownedRoot: '/work/app/.corral/worktrees/profile',
};

function tree(id: string, owner = `agent/${id}`, canvas = CANVAS): NewWorktree {
  return {
    id,
    canvas,
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

/** A repository, and `ids` its workspaces on CANVAS, each its own agent's. */
async function withWorktrees(...ids: string[]): Promise<void> {
  await workspaces.write((w) => {
    w.addRepository(REPO);
    for (const id of ids) w.createWorktree(tree(id));
  });
}

const onDiskCount = (table: string): unknown =>
  reader.prepare(`SELECT count(*) AS rows FROM ${table}`).get()?.rows;

describe('WorkspaceStore', () => {
  it('keeps a repository, found by its real path and identity, its generation moving on as what is known of it changes', async () => {
    const kept = await workspaces.write((w) => w.addRepository(REPO));
    expect(kept).toEqual({ ...REPO, generation: 0 });
    expect(workspaces.repository(REPOSITORY)).toEqual(kept);
    expect(workspaces.repositoryAt('/work/app', 'repository identity')).toEqual(kept);
    expect(workspaces.repositoryAt('/work/app', 'another identity')).toBeUndefined();
    // Found again as it was: nothing moves on.
    expect(
      await workspaces.write((w) => w.rediscovered(REPOSITORY, { pickedRoot: '/work/app' })),
    ).toEqual(kept);
    const moved = await workspaces.write((w) =>
      w.rediscovered(REPOSITORY, { pickedRoot: '/work/link-to-app', commonDir: '/work/app/.git' }),
    );
    expect(moved).toEqual({ ...REPO, pickedRoot: '/work/link-to-app', generation: 1 });
    await expect(workspaces.write((w) => w.addRepository({ ...REPO, id: W1 }))).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(workspaces.write((w) => w.rediscovered(W1, {}))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('binds a canvas to its project folder’s repository, or to none, its generation moving on with each', async () => {
    await workspaces.write((w) => w.addRepository(REPO));
    expect(workspaces.canvasRepository(CANVAS)).toBeUndefined();
    expect(await workspaces.write((w) => w.bindCanvas(CANVAS, REPOSITORY))).toEqual({
      canvas: CANVAS,
      repository: REPOSITORY,
      generation: 1,
    });
    // A folder that isn't a repository: its agents share it.
    expect(await workspaces.write((w) => w.bindCanvas(CANVAS, null))).toEqual({
      canvas: CANVAS,
      repository: null,
      generation: 2,
    });
    expect(await workspaces.write((w) => w.bindCanvas(CANVAS, REPOSITORY))).toMatchObject({
      generation: 3,
    });
    expect(workspaces.canvasRepository(CANVAS)).toEqual({
      canvas: CANVAS,
      repository: REPOSITORY,
      generation: 3,
    });
    await expect(workspaces.write((w) => w.bindCanvas(OTHER, W1))).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('creates a workspace as it is being made, one active per owner of a canvas’s repository, any number kept', async () => {
    now = 5000;
    await withWorktrees();
    const made = await workspaces.write((w) => w.createWorktree(tree(W1, 'group/team')));
    expect(made).toEqual({
      ...tree(W1, 'group/team'),
      state: 'creating',
      generation: 1,
      createdAt: 5000,
      errorCode: null,
    });
    expect(workspaces.worktree(W1)).toEqual(made);
    expect(workspaces.activeWorktree(CANVAS, REPOSITORY, 'group/team')).toEqual(made);
    await expect(workspaces.write((w) => w.createWorktree(tree(W2, 'group/team')))).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await workspaces.write((w) => w.retain(W1));
    expect(workspaces.activeWorktree(CANVAS, REPOSITORY, 'group/team')).toBeUndefined();
    await workspaces.write((w) => w.createWorktree(tree(W2, 'group/team')));
    // Another canvas's group of the same id has its own.
    await workspaces.write((w) => w.createWorktree(tree(W3, 'group/team', OTHER)));
    expect(workspaces.worktreesOf(CANVAS).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: W1, state: 'retained' },
      { id: W2, state: 'creating' },
    ]);
    expect(workspaces.worktreesOf(OTHER).map(({ id }) => id)).toEqual([W3]);
    // Every canvas's, in the states asked for: what a restart checks.
    expect(workspaces.worktreesIn(['creating']).map(({ id }) => id)).toEqual([W2, W3]);
    expect(workspaces.worktreesIn(['retained', 'ready']).map(({ id }) => id)).toEqual([W1]);
    expect(workspaces.worktreesIn([])).toEqual([]);
  });

  it('keeps a lone agent’s workspace as its group’s once it heads one, and back, while it is in use', async () => {
    await withWorktrees(W1, W2);
    // The agent gained its first member: the same checkout is the group's.
    expect(await workspaces.write((w) => w.setOwner(W1, `group/${W1}`))).toMatchObject({
      id: W1,
      owner: `group/${W1}`,
    });
    expect(workspaces.activeWorktree(CANVAS, REPOSITORY, `group/${W1}`)?.id).toBe(W1);
    expect(workspaces.activeWorktree(CANVAS, REPOSITORY, `agent/${W1}`)).toBeUndefined();
    expect(await workspaces.write((w) => w.setOwner(W1, `agent/${W1}`))).toMatchObject({
      owner: `agent/${W1}`,
    });
    // Never two in use for one owner.
    await expect(workspaces.write((w) => w.setOwner(W2, `agent/${W1}`))).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    // One kept is no one's any more.
    await workspaces.write((w) => w.retain(W2));
    await expect(workspaces.write((w) => w.setOwner(W2, 'agent/b'))).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(
      workspaces.write((w) => w.setOwner(W1, 'team' as 'agent/team')),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('moves a workspace through its states only from where it is, refusing a stale or impossible move', async () => {
    await withWorktrees(W1);
    const states = async (...moves: Parameters<WorkspaceStore['transition']>[1][]) => {
      for (const move of moves) await workspaces.write((w) => w.transition(W1, move));
      return workspaces.worktree(W1);
    };
    expect(await states({ from: 'creating', to: 'setup' })).toMatchObject({
      state: 'setup',
      errorCode: null,
    });
    // A stale move: it isn't where the caller thinks.
    await expect(
      workspaces.write((w) =>
        w.transition(W1, { from: 'creating', to: 'error', errorCode: 'git' }),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(
      await states(
        { from: ['setup', 'ready'], to: 'missing', errorCode: 'moved' },
        { from: 'missing', to: 'ready' },
      ),
    ).toMatchObject({ state: 'ready', errorCode: null });
    // A checkout made is never made again over itself.
    await expect(
      workspaces.write((w) => w.transition(W1, { from: 'ready', to: 'creating' })),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(await states({ from: 'ready', to: 'error', errorCode: 'branch-changed' })).toMatchObject(
      { state: 'error', errorCode: 'branch-changed' },
    );
    // An error, or a loss, says why.
    for (const to of ['error', 'missing'] as const) {
      await expect(
        workspaces.write((w) => w.transition(W1, { from: 'error', to })),
        to,
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(await states({ from: 'error', to: 'retained' })).toMatchObject({
      state: 'retained',
      errorCode: null,
    });
    for (const to of ['creating', 'setup', 'ready', 'missing'] as const) {
      await expect(
        workspaces.write((w) => w.transition(W1, { from: 'retained', to, errorCode: 'x' })),
        to,
      ).rejects.toMatchObject({ code: 'refused' });
    }
    expect(await states({ from: 'retained', to: 'removing' })).toMatchObject({
      state: 'removing',
    });
    // A cleanup that failed says so, and is tried again; one that can't be done keeps the tree.
    expect(
      await states({ from: 'removing', to: 'removing', errorCode: 'writer-alive' }),
    ).toMatchObject({ state: 'removing', errorCode: 'writer-alive' });
    expect(await states({ from: 'removing', to: 'retained' })).toMatchObject({
      state: 'retained',
      errorCode: null,
    });
    await expect(
      workspaces.write((w) => w.transition(W2, { from: 'creating', to: 'setup' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('keeps a workspace while a binding refers to it, and forgets it only once removed, unbound and its jobs done', async () => {
    await withWorktrees(W1);
    await workspaces.write((w) => {
      w.createWorktree({ ...tree(W2), forkedFrom: W1 });
      w.bind(CANVAS, 'a', W1);
      w.recordJob({
        id: J1,
        workspace: W1,
        kind: 'create',
        phase: 'intent',
        generation: 1,
        payload: {},
      });
      w.offerSetup(W1, { command: null, source: 'none', specHash: HASH, copyManifestHash: HASH });
    });
    expect(workspaces.worktree(W2)?.forkedFrom).toBe(W1);
    await expect(
      workspaces.write((w) => {
        w.forget(W1);
      }),
    ).rejects.toMatchObject({
      code: 'refused',
    });
    await workspaces.write((w) => w.markRemoving(W1));
    await expect(
      workspaces.write((w) => {
        w.forget(W1);
      }),
    ).rejects.toMatchObject({
      code: 'refused',
    });
    await workspaces.write((w) => {
      w.unbind(CANVAS, 'a');
    });
    // Its job still goes on.
    await expect(
      workspaces.write((w) => {
        w.forget(W1);
      }),
    ).rejects.toMatchObject({
      code: 'refused',
    });
    await workspaces.write((w) => w.finishJob(J1, 'done'));
    await workspaces.write((w) => {
      w.forget(W1);
    });
    expect(workspaces.worktree(W1)).toBeUndefined();
    expect(workspaces.jobsOf(W1)).toEqual([]);
    expect(workspaces.setup(W1)).toBeUndefined();
    expect(workspaces.worktree(W2)?.forkedFrom).toBeNull();
    expect({ jobs: onDiskCount('worktree_job'), setups: onDiskCount('worktree_setup') }).toEqual({
      jobs: 0,
      setups: 0,
    });
  });

  it('binds an agent at a generation never given before, and keeps a plan beside it until installed or cleared', async () => {
    await withWorktrees(W1, W2);
    now = 5000;
    expect(await workspaces.write((w) => w.bind(CANVAS, 'a', W1))).toEqual({
      canvas: CANVAS,
      agent: 'a',
      workspace: W1,
      generation: 5000,
      desired: null,
    });
    // In the same millisecond, or with a clock set back: still past it.
    const planned = await workspaces.write((w) => w.plan(CANVAS, 'a', 'group/team'));
    expect(planned).toEqual({
      canvas: CANVAS,
      agent: 'a',
      workspace: W1,
      generation: 5000,
      desired: { generation: 5001, owner: 'group/team' },
    });
    now = 4000;
    // Installing the plan binds it at the generation reviewed.
    expect(await workspaces.write((w) => w.bind(CANVAS, 'a', W2))).toEqual({
      canvas: CANVAS,
      agent: 'a',
      workspace: W2,
      generation: 5001,
      desired: null,
    });
    await workspaces.write((w) => w.plan(CANVAS, 'a', 'agent/a'));
    expect(await workspaces.write((w) => w.clearPlan(CANVAS, 'a'))).toMatchObject({
      generation: 5001,
      desired: null,
    });
    // Unbound and bound again, as an agent deleted and another of its id added: past every one.
    await workspaces.write((w) => {
      w.unbind(CANVAS, 'a');
    });
    expect(workspaces.binding(CANVAS, 'a')).toBeUndefined();
    now = 9000;
    expect(await workspaces.write((w) => w.bind(CANVAS, 'a', W1))).toMatchObject({
      generation: 9000,
    });
    await workspaces.write((w) => w.bind(CANVAS, 'b', W1));
    expect(workspaces.bindingsTo(CANVAS, W1).map(({ agent }) => agent)).toEqual(['a', 'b']);
    expect(workspaces.bindingsOf(CANVAS).map(({ agent }) => agent)).toEqual(['a', 'b']);
    // A workspace moves on for every agent bound to it: a change waiting for one moves past it,
    // a plan no longer the one reviewed.
    await workspaces.write((w) => w.plan(CANVAS, 'b', 'group/team'));
    expect(workspaces.binding(CANVAS, 'b')?.desired).toEqual({
      generation: 9002,
      owner: 'group/team',
    });
    const advanced = await workspaces.write((w) => w.advance(W1));
    expect(advanced.generation).toBe(2);
    expect(workspaces.bindingsTo(CANVAS, W1)).toEqual([
      { canvas: CANVAS, agent: 'a', workspace: W1, generation: 9003, desired: null },
      {
        canvas: CANVAS,
        agent: 'b',
        workspace: W1,
        generation: 9004,
        desired: { generation: 9005, owner: 'group/team' },
      },
    ]);
    // No plan without a binding, nor a binding to what is kept, gone, or another canvas's.
    await expect(workspaces.write((w) => w.plan(CANVAS, 'c', 'agent/c'))).rejects.toMatchObject({
      code: 'not-found',
    });
    await workspaces.write((w) => w.retain(W2));
    await expect(workspaces.write((w) => w.bind(CANVAS, 'c', W2))).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(workspaces.write((w) => w.bind(OTHER, 'c', W1))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('records a job once, however often it is asked, with only one of a kind going on for a workspace', async () => {
    await withWorktrees(W1, W2);
    now = 2000;
    const job = {
      id: J1,
      workspace: W1,
      kind: 'create' as const,
      phase: 'intent',
      generation: 1,
      expectedIdentity: 'repository identity',
      payload: { destination: tree(W1).path, ref: tree(W1).branchRef, base: OID },
    };
    const recorded = await workspaces.write((w) => w.recordJob(job));
    expect(recorded).toEqual({ ...job, outcome: null, createdAt: 2000, updatedAt: 2000 });
    // Asked again (a retry of the same intent): the same job.
    now = 3000;
    expect(await workspaces.write((w) => w.recordJob(job))).toEqual(recorded);
    await expect(
      workspaces.write((w) => w.recordJob({ ...job, payload: { other: true } })),
    ).rejects.toMatchObject({ code: 'refused' });
    await expect(workspaces.write((w) => w.recordJob({ ...job, id: J2 }))).rejects.toMatchObject({
      code: 'refused',
    });
    expect(workspaces.openJob(W1, 'create')).toEqual(recorded);
    // Each phase marked as it is done, from the one it was in.
    expect(
      await workspaces.write((w) => w.advanceJob(J1, { from: 'intent', to: 'branch' })),
    ).toMatchObject({ phase: 'branch', updatedAt: 3000 });
    await expect(
      workspaces.write((w) => w.advanceJob(J1, { from: 'intent', to: 'registered' })),
    ).rejects.toMatchObject({ code: 'stale' });
    await workspaces.write((w) =>
      w.recordJob({
        id: J2,
        workspace: W2,
        kind: 'create',
        phase: 'intent',
        generation: 1,
        payload: null,
      }),
    );
    // What a restart finishes: every job going on, oldest first.
    expect(workspaces.openJobs().map(({ id }) => id)).toEqual([J1, J2]);
    expect(
      await workspaces.write((w) =>
        w.advanceJob(J1, { from: 'branch', to: 'registered', payload: { registered: true } }),
      ),
    ).toMatchObject({ phase: 'registered', payload: { registered: true } });
    expect(await workspaces.write((w) => w.finishJob(J1, 'done'))).toMatchObject({
      outcome: 'done',
    });
    await expect(workspaces.write((w) => w.finishJob(J1, 'failed'))).rejects.toMatchObject({
      code: 'stale',
    });
    await expect(
      workspaces.write((w) => w.advanceJob(J1, { from: 'registered', to: 'verified' })),
    ).rejects.toMatchObject({ code: 'stale' });
    // Done, another of its kind may begin.
    await workspaces.write((w) =>
      w.recordJob({
        id: J3,
        workspace: W1,
        kind: 'create',
        phase: 'intent',
        generation: 2,
        payload: {},
      }),
    );
    expect(workspaces.openJobs().map(({ id }) => id)).toEqual([J2, J3]);
    expect(workspaces.jobsOf(W1).map(({ id }) => id)).toEqual([J1, J3]);
  });

  it('offers setup a generation at a time, runs it only once allowed, and interrupts what ran as the core stopped', async () => {
    await withWorktrees(W1, W2);
    now = 2000;
    const offer = {
      command: 'pnpm install --frozen-lockfile',
      source: 'detected' as const,
      specHash: HASH,
      copyManifestHash: OTHER_HASH,
    };
    expect(await workspaces.write((w) => w.offerSetup(W1, offer))).toEqual({
      workspace: W1,
      generation: 1,
      ...offer,
      state: 'pending',
      approvedBy: null,
      approvedAt: null,
      logKey: null,
      exitCode: null,
    });
    // Nothing to run, nothing to allow: only skipped.
    await workspaces.write((w) =>
      w.offerSetup(W2, { command: null, source: 'none', specHash: HASH, copyManifestHash: HASH }),
    );
    await expect(
      workspaces.write((w) => w.startSetup(W2, { generation: 1, by: 'you', logKey: 'log' })),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(await workspaces.write((w) => w.skipSetup(W2, 1))).toMatchObject({ state: 'skipped' });
    // Allowed and running: its approval on disk before anything runs.
    now = 3000;
    let seen: unknown;
    await workspaces
      .write((w) => w.startSetup(W1, { generation: 1, by: 'you', logKey: 'setup-1' }))
      .then(() => {
        seen = reader
          .prepare(
            'SELECT state, approved_by, approved_at, log_key FROM worktree_setup WHERE workspace_id = ?',
          )
          .get(W1);
      });
    expect(seen).toEqual({
      state: 'running',
      approved_by: 'you',
      approved_at: 3000,
      log_key: 'setup-1',
    });
    // A new offer waits until it is done; an old generation's answer is stale.
    await expect(workspaces.write((w) => w.offerSetup(W1, offer))).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(workspaces.write((w) => w.finishSetup(W1, 2, 0))).rejects.toMatchObject({
      code: 'stale',
    });
    expect(await workspaces.write((w) => w.finishSetup(W1, 1, 1))).toMatchObject({
      state: 'failed',
      exitCode: 1,
    });
    // Retried: allowed again, it runs again; done once it exits 0.
    await workspaces.write((w) =>
      w.startSetup(W1, { generation: 1, by: 'you', logKey: 'setup-2' }),
    );
    expect(await workspaces.write((w) => w.finishSetup(W1, 1, 0))).toMatchObject({
      state: 'done',
      exitCode: 0,
    });
    // A changed offer is a new generation, asked again.
    expect(
      await workspaces.write((w) => w.offerSetup(W1, { ...offer, specHash: OTHER_HASH })),
    ).toMatchObject({
      generation: 2,
      state: 'pending',
      approvedBy: null,
      exitCode: null,
    });
    await workspaces.write((w) =>
      w.startSetup(W1, { generation: 2, by: 'you', logKey: 'setup-3' }),
    );
    // The core stopped while it ran: whether it did what it does is unknown, so it is never run
    // again by itself.
    expect(await workspaces.write((w) => w.interruptSetups())).toEqual([W1]);
    expect(workspaces.setup(W1)).toMatchObject({ state: 'interrupted', approvedBy: 'you' });
    expect(await workspaces.write((w) => w.interruptSetups())).toEqual([]);
    await expect(
      workspaces.write((w) =>
        w.startSetup(W1, { generation: 2, by: 'not a party' as 'you', logKey: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps a repository’s setup command and what is allowed always, Always cleared whenever either the command or how it runs changes', async () => {
    await withWorktrees();
    expect(workspaces.projectSetup(REPOSITORY)).toBeUndefined();
    now = 2000;
    // Always for the detected command: no command of yours.
    expect(await workspaces.write((w) => w.setAlways(REPOSITORY, HASH))).toEqual({
      repository: REPOSITORY,
      command: null,
      shellKind: null,
      alwaysSpecHash: HASH,
      changedAt: 2000,
    });
    now = 3000;
    expect(
      await workspaces.write((w) => w.setProjectCommand(REPOSITORY, 'make setup', 'posix')),
    ).toEqual({
      repository: REPOSITORY,
      command: 'make setup',
      shellKind: 'posix',
      alwaysSpecHash: null,
      changedAt: 3000,
    });
    await workspaces.write((w) => w.setAlways(REPOSITORY, OTHER_HASH));
    // The same command, as it was: Always holds.
    expect(
      await workspaces.write((w) => w.setProjectCommand(REPOSITORY, 'make setup', 'posix')),
    ).toMatchObject({ alwaysSpecHash: OTHER_HASH });
    expect(
      await workspaces.write((w) => w.setProjectCommand(REPOSITORY, 'make setup', 'windows')),
    ).toMatchObject({ alwaysSpecHash: null });
    await workspaces.write((w) => w.setAlways(REPOSITORY, OTHER_HASH));
    expect(
      await workspaces.write((w) => w.setProjectCommand(REPOSITORY, null, null)),
    ).toMatchObject({ command: null, shellKind: null, alwaysSpecHash: null });
    await workspaces.write((w) => w.setAlways(REPOSITORY, null));
    expect(workspaces.projectSetup(REPOSITORY)?.alwaysSpecHash).toBeNull();
    for (const command of ['', ' ', 'make\nsetup', 'make\u0007', 'x'.repeat(4097)]) {
      await expect(
        workspaces.write((w) => w.setProjectCommand(REPOSITORY, command, 'posix')),
        JSON.stringify(command),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(
      workspaces.write((w) => w.setProjectCommand(REPOSITORY, 'make setup', null)),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('writes within another store’s write: all of it on disk, or none of it', async () => {
    await withWorktrees();
    const journal = new RunJournal({ store, memory });
    await journal.opened(CANVAS);
    const { token } = await journal.get(CANVAS);
    const checkpoint = { version: 2, state: '{}', messages: '[]', updatedAt: 1 } as const;
    let seen: unknown;
    await store
      .write(() => {
        journal.keep(CANVAS, token, checkpoint);
        workspaces.createWorktree(tree(W1));
        workspaces.bind(CANVAS, 'a', W1);
        workspaces.recordJob({
          id: J1,
          workspace: W1,
          kind: 'create',
          phase: 'intent',
          generation: 1,
          payload: {},
        });
      })
      .then(() => {
        seen = {
          run: onDiskCount('run'),
          worktree: onDiskCount('worktree'),
          bound: onDiskCount('agent_worktree'),
          jobs: onDiskCount('worktree_job'),
        };
      });
    expect(seen).toEqual({ run: 1, worktree: 1, bound: 1, jobs: 1 });

    // The job can't be written: neither is anything else of the write.
    const release = refuseWrites(profile, 'worktree_job', 'The disk is full');
    await expect(
      store.write(() => {
        journal.keep(CANVAS, token, { ...checkpoint, updatedAt: 2 });
        workspaces.createWorktree(tree(W2));
        workspaces.recordJob({
          id: J2,
          workspace: W2,
          kind: 'create',
          phase: 'intent',
          generation: 1,
          payload: {},
        });
      }),
    ).rejects.toThrow('The disk is full');
    expect(workspaces.worktree(W2)).toBeUndefined();
    expect(reader.prepare('SELECT updated_at FROM run').get()).toEqual({ updated_at: 1 });
    release();
  });

  it('records its intents within a document’s commit: the commit and the intent, or neither', async () => {
    await withWorktrees();
    const documents = new Documents({
      store,
      memory,
      catalog: CATALOG,
      defaultAdapter: DEFAULT_ADAPTER,
    });
    const agent = (id: string): CanvasDocument['nodes'][number] => ({
      id,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: id, adapter: 'codex' },
    });
    const document = (...ids: string[]): CanvasDocument => ({
      id: CANVAS,
      arrange: false,
      nodes: ids.map(agent),
      links: [],
    });
    documents.create(CANVAS, 'you');
    await commitDocument(documents, CANVAS, document('a'));
    /** Adds `id` to the canvas, recording its workspace and its job in the same write. */
    const add = (id: string, workspace: string, job: string) =>
      documents.change(CANVAS, {
        revision: { op: 'canvas.addAgent', by: 'you' },
        build: (live) => ({
          next: { ...live, nodes: [...live.nodes, agent(id)] },
          result: undefined,
        }),
        check: () => undefined,
        committing: () => undefined,
        within: () => {
          workspaces.createWorktree(tree(workspace));
          workspaces.bind(CANVAS, id, workspace);
          workspaces.recordJob({
            id: job,
            workspace,
            kind: 'create',
            phase: 'intent',
            generation: 1,
            payload: {},
          });
          return { reveal: () => undefined, undo: () => undefined };
        },
      });
    await add('b', W1, J1);
    expect(documents.live(CANVAS).document.nodes.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(workspaces.binding(CANVAS, 'b')?.workspace).toBe(W1);
    expect(workspaces.openJob(W1, 'create')?.id).toBe(J1);

    const release = refuseWrites(profile, 'worktree_job', 'The disk is full');
    await expect(add('c', W2, J2)).rejects.toThrow(/The disk is full/);
    release();
    expect(documents.live(CANVAS).document.nodes.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(reader.prepare("SELECT count(*) AS rows FROM node WHERE id = 'c'").get()).toEqual({
      rows: 0,
    });
    expect(workspaces.worktree(W2)).toBeUndefined();
    expect(workspaces.binding(CANVAS, 'c')).toBeUndefined();
  });

  it('refuses what isn’t a record of its own: its ids, paths, refs, hashes and codes are checked', async () => {
    await withWorktrees(W1);
    const refused: (() => unknown)[] = [
      () => workspaces.addRepository({ ...REPO, id: 'not a uuid' }),
      () => workspaces.addRepository({ ...REPO, id: W3, pickedRoot: 'relative/app' }),
      () => workspaces.addRepository({ ...REPO, id: W3, realRoot: '/work/\0app' }),
      () => workspaces.addRepository({ ...REPO, id: W3, rootKind: 'anywhere' as 'project' }),
      () => workspaces.addRepository({ ...REPO, id: W3, identity: '' }),
      () => workspaces.createWorktree({ ...tree(W2), canvas: 'not a canvas' as CanvasId }),
      () => workspaces.createWorktree({ ...tree(W2), owner: 'team' as NewWorktree['owner'] }),
      () => workspaces.createWorktree({ ...tree(W2), path: 'w2' }),
      () => workspaces.createWorktree({ ...tree(W2), branchRef: 'main' }),
      () => workspaces.createWorktree({ ...tree(W2), branchRef: 'refs/heads/-x' }),
      () => workspaces.createWorktree({ ...tree(W2), branchRef: 'refs/heads/a..b' }),
      () => workspaces.createWorktree({ ...tree(W2), branchRef: 'refs/heads/a b' }),
      () => workspaces.createWorktree({ ...tree(W2), baseRef: '--orphan' }),
      () => workspaces.createWorktree({ ...tree(W2), baseOid: 'HEAD' }),
      () => workspaces.createWorktree({ ...tree(W2), forkedFrom: 'not a uuid' }),
      () => workspaces.transition(W1, { from: 'creating', to: 'error', errorCode: 'Not A Code' }),
      () =>
        workspaces.recordJob({
          id: J1,
          workspace: W1,
          kind: 'teleport' as 'create',
          phase: 'intent',
          generation: 1,
          payload: {},
        }),
      () =>
        workspaces.recordJob({
          id: J1,
          workspace: W1,
          kind: 'create',
          phase: 'Intent!',
          generation: 1,
          payload: {},
        }),
      () =>
        workspaces.recordJob({
          id: J1,
          workspace: W1,
          kind: 'create',
          phase: 'intent',
          generation: -1,
          payload: {},
        }),
      () =>
        workspaces.recordJob({
          id: J1,
          workspace: W1,
          kind: 'create',
          phase: 'intent',
          generation: 1,
          payload: 'x'.repeat(70_000),
        }),
      () =>
        workspaces.offerSetup(W1, {
          command: 'npm ci',
          source: 'detected',
          specHash: 'short',
          copyManifestHash: HASH,
        }),
      () =>
        workspaces.offerSetup(W1, {
          command: null,
          source: 'detected',
          specHash: HASH,
          copyManifestHash: HASH,
        }),
      () =>
        workspaces.offerSetup(W1, {
          command: 'npm ci',
          source: 'none',
          specHash: HASH,
          copyManifestHash: HASH,
        }),
      () => workspaces.setAlways(REPOSITORY, 'not a hash'),
      () => workspaces.bind(CANVAS, '', W1),
    ];
    for (const [i, write] of refused.entries()) {
      await expect(workspaces.write(write), String(i)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(onDiskCount('repository')).toBe(1);
    expect(onDiskCount('worktree')).toBe(1);
    expect(onDiskCount('worktree_job')).toBe(0);
  });

  it('reads nothing it can’t read as what it wrote: such a record fails its read, saying which', async () => {
    await withWorktrees(W1);
    await store.write(() => {
      store
        .prepare(
          `INSERT INTO worktree_job (id, workspace_id, kind, phase, generation, payload, intent_hash, created_at,
             updated_at)
           VALUES (?, ?, 'teleport', 'intent', 1, '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 1)`,
        )
        .run(J1, W1);
    });
    expect(() => workspaces.job(J1)).toThrow(/worktree_job .*can’t be read/);
    expect(() => workspaces.openJobs()).toThrow(/worktree_job .*can’t be read/);
    expect(() => workspaces.jobsOf(W1)).toThrow(/worktree_job .*can’t be read/);
  });

  it('never reuses a cleared plan or deleted binding generation, even after a restart and a clock rollback', async () => {
    await withWorktrees(W1, W2);
    const first = await workspaces.write((w) => w.bind(CANVAS, 'a', W1));
    const planned = await workspaces.write((w) => w.plan(CANVAS, 'a', 'group/team'));
    await workspaces.write((w) => w.clearPlan(CANVAS, 'a'));
    const replanned = await workspaces.write((w) => w.plan(CANVAS, 'a', 'group/other'));
    expect.soft(replanned.desired?.generation).toBeGreaterThan(planned.desired?.generation ?? 0);
    const highest = replanned.desired?.generation ?? first.generation;
    await workspaces.write((w) => {
      w.unbind(CANVAS, 'a');
    });
    const replaced = await workspaces.write((w) => w.bind(CANVAS, 'a', W2));
    expect(replaced.generation).toBeGreaterThan(highest);
    await workspaces.write((w) => {
      w.unbind(CANVAS, 'a');
    });
    reader.close();
    await store.close();
    store = await openTestStore(profile);
    reader = onDisk(profile);
    now = 500;
    workspaces = new WorkspaceStore({ store, now: () => now });
    const again = await workspaces.write((w) => w.bind(CANVAS, 'a', W2));
    expect(again.generation).toBeGreaterThan(replaced.generation);
  });

  it('rolls back generation allocation with a refused binding write', async () => {
    await withWorktrees(W1);
    const binding = await workspaces.write((w) => w.bind(CANVAS, 'a', W1));
    const before = store.prepare('SELECT workspace_generation FROM meta WHERE id = 1').get();
    const release = refuseWrites(profile, 'agent_worktree', 'The disk is full');
    try {
      await expect(workspaces.write((w) => w.plan(CANVAS, 'a', 'group/team'))).rejects.toThrow(
        'The disk is full',
      );
    } finally {
      release();
    }
    expect(workspaces.binding(CANVAS, 'a')).toEqual(binding);
    expect(store.prepare('SELECT workspace_generation FROM meta WHERE id = 1').get()).toEqual(
      before,
    );
    expect(
      (await workspaces.write((w) => w.plan(CANVAS, 'a', 'group/team'))).desired?.generation,
    ).toBe(binding.generation + 1);
  });

  it('accepts the picked branch’s full Git ref, without loosening generated branch names', async () => {
    await withWorktrees();
    for (const [id, baseRef] of [
      [W1, 'refs/heads/feature/é+@-topic'],
      [W2, 'refs/heads/topic/-part'],
    ] as const) {
      expect(
        await workspaces.write((w) => w.createWorktree({ ...tree(id), baseRef })),
      ).toMatchObject({ baseRef });
    }
    for (const baseRef of [
      '--orphan',
      'refs/heads/a..b',
      'refs/heads/a@{b',
      'refs/heads/.hidden',
      'refs/heads/a.lock',
      'refs/heads/a\\b',
      'refs/heads/a?b',
      'refs/heads/a b',
    ]) {
      await expect(
        workspaces.write((w) => w.createWorktree({ ...tree(W3), baseRef })),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(
      workspaces.write((w) => w.createWorktree({ ...tree(W3), branchRef: 'refs/heads/feature/é' })),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('recognizes the original job intent after its progress payload changes', async () => {
    await withWorktrees(W1);
    const job = {
      id: J1,
      workspace: W1,
      kind: 'create' as const,
      phase: 'intent',
      generation: 1,
      payload: { base: OID, destination: tree(W1).path },
    };
    await workspaces.write((w) => w.recordJob(job));
    const advanced = await workspaces.write((w) =>
      w.advanceJob(J1, { from: 'intent', to: 'registered', payload: { registered: true } }),
    );
    reader.close();
    await store.close();
    store = await openTestStore(profile);
    reader = onDisk(profile);
    workspaces = new WorkspaceStore({ store, now: () => now });
    expect(await workspaces.write((w) => w.recordJob(job))).toEqual(advanced);
    expect(
      await workspaces.write((w) =>
        w.recordJob({ ...job, payload: { destination: tree(W1).path, base: OID } }),
      ),
    ).toEqual(advanced);
    await expect(
      workspaces.write((w) =>
        w.recordJob({ ...job, payload: { base: 'b'.repeat(40), destination: tree(W1).path } }),
      ),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('validates kept values as strictly as new ones, instead of trusting their SQLite types', async () => {
    await withWorktrees(W1);
    await workspaces.write((w) => {
      w.bind(CANVAS, 'a', W1);
      w.recordJob({
        id: J1,
        workspace: W1,
        kind: 'create',
        phase: 'intent',
        generation: 1,
        payload: {},
      });
      w.offerSetup(W1, {
        command: 'npm ci',
        source: 'detected',
        specHash: HASH,
        copyManifestHash: HASH,
      });
      w.setProjectCommand(REPOSITORY, 'npm ci', 'posix');
    });
    const cases = [
      ['repository', 'picked_root', 'relative', () => workspaces.repository(REPOSITORY)],
      ['repository', 'identity', 'bad\nidentity', () => workspaces.repository(REPOSITORY)],
      ['worktree', 'branch_ref', '--help', () => workspaces.worktree(W1)],
      ['worktree', 'base_oid', 'HEAD', () => workspaces.worktree(W1)],
      ['worktree', 'path', 'relative', () => workspaces.worktree(W1)],
      ['agent_worktree', 'agent_id', '', () => workspaces.bindingsOf(CANVAS)],
      ['worktree_job', 'phase', 'Not a phase', () => workspaces.job(J1)],
      ['worktree_job', 'payload', JSON.stringify('x'.repeat(70_000)), () => workspaces.job(J1)],
      ['worktree_setup', 'spec_hash', 'not a hash', () => workspaces.setup(W1)],
      ['worktree_setup', 'command_snapshot', 'echo a\necho b', () => workspaces.setup(W1)],
      [
        'project_setup',
        'always_spec_hash',
        'not a hash',
        () => workspaces.projectSetup(REPOSITORY),
      ],
      ['project_setup', 'command', 'echo a\necho b', () => workspaces.projectSetup(REPOSITORY)],
    ] as const;
    for (const [table, column, bad, read] of cases) {
      await store.write(() => {
        const previous = store.prepare(`SELECT ${column} AS value FROM ${table}`).get()?.value;
        store.prepare(`UPDATE ${table} SET ${column} = ?`).run(bad);
        expect.soft(read, `${table}.${column}`).toThrow(/can’t be read/);
        store.prepare(`UPDATE ${table} SET ${column} = ?`).run(previous ?? null);
      });
    }
  });

  it('fails every read and write, saying why, when the database couldn’t be opened', async () => {
    const why = 'The core’s database could not be opened (disk I/O error).';
    const none = new WorkspaceStore({ store: unopened(why) });
    expect(() => none.worktreesOf(CANVAS)).toThrow(why);
    expect(() => none.openJobs()).toThrow(why);
    await expect(none.write((w) => w.addRepository(REPO))).rejects.toThrow(why);
    expect(WorkspaceStoreError).toBeDefined();
  });
});
