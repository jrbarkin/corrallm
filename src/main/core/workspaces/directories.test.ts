import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/api/ids';
import { newCanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { CanvasMemory } from '../../memory';
import { mintTrustedPath } from '../host';
import { openTestStore } from '../store/test-store';
import type { Store } from '../store/store';
import { WorkspaceDirectories } from './directories';
import type { WorkspaceDirectoriesDeps } from './directories';
import { WorkspaceStore } from './store';
import type { RepositoryRecord, WorktreeRecord } from './store';

const canvas = newCanvasId();
const agent = AgentId.parse('a');
const id = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
let folder: string;
let store: Store;
let workspaces: WorkspaceStore;
let directories: WorkspaceDirectories;
let root: ReturnType<typeof mintTrustedPath> | undefined;
let document: CanvasDocument;
let repository: RepositoryRecord;
let tree: WorktreeRecord;
let changed: () => void;
let deps: WorkspaceDirectoriesDeps;
let checkout: ReturnType<typeof vi.fn<WorkspaceDirectoriesDeps['provisioner']['checkout']>>;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-workspace-resolver-'));
  store = await openTestStore(folder);
  const memory = new CanvasMemory(store);
  workspaces = new WorkspaceStore({ store });
  root = mintTrustedPath('/picked');
  document = {
    arrange: false,
    id: canvas,
    nodes: [
      { id: agent, type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A', queue: [] } },
    ],
    links: [],
  };
  await store.write(() => {
    memory.ensure(canvas);
  });
  await workspaces.write((w) => {
    repository = w.addRepository({
      id: repositoryId,
      pickedRoot: '/picked',
      realRoot: '/picked',
      commonDir: '/picked/.git',
      identity: 'repository',
      rootKind: 'project',
      ownedRoot: '/picked/.corral/worktrees/profile',
    });
    w.bindCanvas(canvas, repository.id);
    tree = w.createWorktree({
      id,
      canvas,
      repository: repository.id,
      owner: 'agent/a',
      path: `/picked/.corral/worktrees/profile/${id}`,
      branchRef: `refs/heads/corrallm/profile/${id}`,
      baseCheckout: '/picked',
      baseRef: 'refs/heads/main',
      baseOid: 'a'.repeat(40),
      forkedFrom: null,
    });
    w.bind(canvas, agent, tree.id);
  });
  checkout = vi.fn().mockResolvedValue({
    state: 'ready',
    cwd: mintTrustedPath(tree.path),
    worktree: tree,
    branch: tree.branchRef,
  });
  deps = {
    projects: {
      of: () => root,
      onAvailability: (_canvas, listener) => {
        changed = listener;
        return () => undefined;
      },
    },
    workspaces,
    provisioner: {
      repository: vi.fn().mockResolvedValue({
        kind: 'repository',
        record: repository,
        found: {
          pickedRoot: '/picked',
          realRoot: '/picked',
          gitDir: '/picked/.git',
          commonDir: '/picked/.git',
          identity: 'repository',
          head: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
          drivers: [],
        },
      }),
      provision: vi.fn().mockResolvedValue(tree),
      run: vi.fn().mockResolvedValue(tree),
      checkout,
      reconcile: vi.fn().mockResolvedValue(undefined),
    },
    setups: {
      prepare: vi.fn().mockResolvedValue(undefined),
      reconcile: vi.fn().mockResolvedValue(undefined),
    },
    document: () => Promise.resolve(document),
    documentNow: () => document,
  };
  directories = new WorkspaceDirectories(deps);
});
afterEach(async () => {
  await directories.close();
  await store.close();
  await rm(folder, { recursive: true, force: true });
});

it('uses the active generation and re-verifies the checkout on every read', async () => {
  const binding = workspaces.binding(canvas, agent);
  expect(await directories.workingDirectory(canvas, agent)).toMatchObject({
    state: 'ready',
    cwd: tree.path,
    workspace: tree.id,
    generation: binding?.generation,
  });
  await directories.workingDirectory(canvas, agent);
  expect(checkout).toHaveBeenCalledTimes(2);
});
it('holds pending rebinds without verifying or ending the old session', async () => {
  await workspaces.write((w) => {
    w.plan(canvas, agent, 'group/g');
  });
  const binding = workspaces.binding(canvas, agent);
  expect(await directories.workingDirectory(canvas, agent)).toMatchObject({
    state: 'held',
    reason: 'pending-change',
    need: `rebind/group%2Fg/${String(binding?.desired?.generation)}`,
  });
  expect(checkout).not.toHaveBeenCalled();
});
it('rejects a verification that crossed a desired generation change', async () => {
  const checked = Promise.withResolvers<Awaited<ReturnType<typeof checkout>>>();
  checkout.mockReturnValueOnce(checked.promise);
  const reading = directories.workingDirectory(canvas, agent);
  await vi.waitFor(() => {
    expect(checkout).toHaveBeenCalledOnce();
  });
  await workspaces.write((w) => {
    w.plan(canvas, agent, 'group/g');
  });
  checked.resolve({
    state: 'ready',
    cwd: mintTrustedPath(tree.path),
    worktree: tree,
    branch: tree.branchRef,
  });
  expect(await reading).toMatchObject({ state: 'held', reason: 'pending-change' });
});
it('runs the open job of a bound tree still being made, holding its starts meanwhile', async () => {
  const job = '33333333-3333-4333-8333-333333333333';
  await workspaces.write((w) => {
    w.recordJob({
      id: job,
      workspace: tree.id,
      kind: 'create',
      phase: 'recorded',
      generation: tree.generation,
      payload: {},
    });
  });
  checkout.mockResolvedValue({ state: 'held', reason: 'creating', worktree: tree });
  vi.mocked(deps.provisioner.run).mockRejectedValue(new Error('Too many workspaces.'));
  const heard = vi.fn();
  directories.onAvailability(canvas, heard);
  expect(await directories.workingDirectory(canvas, agent)).toMatchObject({
    state: 'held',
    reason: 'creating',
  });
  expect(deps.provisioner.run).toHaveBeenCalledWith(job);
  // A run refused says nothing: no listener asks again at once, round and round.
  await Promise.resolve();
  expect(heard).not.toHaveBeenCalled();
  expect(deps.provisioner.provision).not.toHaveBeenCalled();
});
it('offers setup and never hands an unready checkout to a CLI', async () => {
  checkout.mockResolvedValue({
    state: 'setup',
    cwd: mintTrustedPath(tree.path),
    worktree: tree,
    branch: tree.branchRef,
  });
  expect(await directories.workingDirectory(canvas, agent)).toMatchObject({
    state: 'held',
    reason: 'setup',
  });
  expect(deps.setups.prepare).toHaveBeenCalledWith(tree.id);
});
it('keeps the legacy directory only for a folder discovery identifies as non-Git', async () => {
  await workspaces.write((w) => {
    w.unbind(canvas, agent);
    w.retain(tree.id);
    w.bindCanvas(canvas, null);
  });
  vi.mocked(deps.provisioner.repository).mockResolvedValue({ kind: 'not-git' });
  expect(await directories.workingDirectory(canvas, agent)).toEqual({
    state: 'ready',
    cwd: '/picked',
    workspace: null,
    generation: 0,
    branch: null,
  });
  expect(checkout).not.toHaveBeenCalled();
});
it('never falls back to the picked root after discovery refuses it', async () => {
  vi.mocked(deps.provisioner.repository).mockResolvedValue({
    kind: 'refused',
    reason: 'config',
    sentence: 'Unsafe repository configuration.',
  });
  expect(await directories.workingDirectory(canvas, agent)).toEqual({
    state: 'held',
    reason: 'error',
    sentence: 'Unsafe repository configuration.',
  });
  expect(checkout).not.toHaveBeenCalled();
});
it('announces a changed or forgotten project and holds after it is forgotten', async () => {
  const heard = vi.fn();
  const stop = directories.onAvailability(canvas, heard);
  root = undefined;
  changed();
  expect(heard).toHaveBeenCalledOnce();
  expect(await directories.workingDirectory(canvas, agent)).toMatchObject({
    state: 'held',
    reason: 'no-project',
  });
  stop();
  changed();
  expect(heard).toHaveBeenCalledOnce();
});
it('recovers provisioning before preparing setup, and shares recovery', async () => {
  const order: string[] = [];
  vi.mocked(deps.provisioner.reconcile).mockImplementation(() => {
    order.push('provision');
    return Promise.resolve();
  });
  vi.spyOn(deps.setups, 'reconcile').mockImplementation(() => {
    order.push('setup');
    return Promise.resolve();
  });
  await Promise.all([directories.reconcile(), directories.reconcile()]);
  expect(order).toEqual(['provision', 'setup']);
});
