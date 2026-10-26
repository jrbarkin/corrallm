import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import { CanvasMemory } from '../../memory';
import { mintTrustedPath } from '../host';
import { WorkspaceCleanup, fingerprint } from './cleanup';
import { GitRunner } from './git';
import type { GitCall } from './git';
import { listWorktrees } from './list';
import { Provisioner } from './provision';
import { ProvisioningQueue } from './queue';
import { WorkspaceSetups } from './setup';
import { SetupProcess } from './setup-run';
import { CANVAS, PROFILE_ID, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

vi.setConfig({ testTimeout: 30_000 });
let fixture: TestWorkspaces | undefined;
let setups: WorkspaceSetups | undefined;
afterEach(async () => {
  await setups?.close();
  setups = undefined;
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = undefined;
});

it('preserves tracked and untracked work after a durably populated creation resumes', async () => {
  const w = (fixture = await testWorkspaces());
  class Crash extends GitRunner {
    override async run(call: GitCall) {
      if (w.workspaces.openJobs()[0]?.phase === 'populated') throw new Error('crash after mark');
      return super.run(call);
    }
  }
  const first = new Provisioner({
    workspaces: w.workspaces,
    git: new Crash(w.runnerDeps),
    profile: PROFILE_ID,
  });
  await expect(
    first.provision({ canvas: CANVAS, repository: await w.repository(), owner: 'agent/builder' }),
  ).rejects.toThrow('crash after mark');
  const tree = w.workspaces.worktreesOf(CANVAS)[0];
  if (!tree) throw new Error('Missing intent');
  expect(w.workspaces.openJobs()[0]?.phase).toBe('populated');
  writeFileSync(path.join(tree.path, 'README.md'), 'tracked work\n');
  writeFileSync(path.join(tree.path, 'notes.txt'), 'untracked work\n');
  await w.provisioner.reconcile();
  expect(w.workspaces.worktree(tree.id)?.state).toBe('setup');
  expect(readFileSync(path.join(tree.path, 'README.md'), 'utf8')).toBe('tracked work\n');
  expect(readFileSync(path.join(tree.path, 'notes.txt'), 'utf8')).toBe('untracked work\n');
  expect(w.workspaces.jobsOf(tree.id)).toMatchObject([{ outcome: 'done' }]);
});

it('serializes real Git mutations of two canvases sharing a repository lane', async () => {
  const w = (fixture = await testWorkspaces());
  const other = '22222222-2222-4222-8222-222222222222' as CanvasId;
  await w.store.write(() => {
    new CanvasMemory(w.store).ensure(other);
  });
  let active = 0;
  let maximum = 0;
  class Observe extends GitRunner {
    override async run(call: GitCall) {
      const mutation =
        call.args[0] === 'update-ref' ||
        call.args[0] === 'read-tree' ||
        (call.args[0] === 'worktree' && call.args[1] === 'add');
      if (mutation) {
        active++;
        maximum = Math.max(maximum, active);
      }
      try {
        return await super.run(call);
      } finally {
        if (mutation) active--;
      }
    }
  }
  const shared = new Provisioner({
    workspaces: w.workspaces,
    git: new Observe(w.runnerDeps),
    profile: PROFILE_ID,
    queue: new ProvisioningQueue(),
  });
  const repository = await w.repository();
  const trees = await Promise.all(
    [CANVAS, other].map((canvas) =>
      shared.provision({ canvas, repository, owner: 'agent/builder' }),
    ),
  );
  expect(maximum).toBe(1);
  expect(trees.map((tree) => tree.state)).toEqual(['setup', 'setup']);
  expect(new Set(trees.map((tree) => tree.path)).size).toBe(2);
  expect(new Set(trees.map((tree) => tree.branchRef)).size).toBe(2);
});

it('uses the captured include manifest and keeps copies, setup choices and paths private from tokens', async () => {
  const w = (fixture = await testWorkspaces({
    '.gitignore': '.env.*\n',
    '.worktreeinclude': '.env.allowed\n',
    'README.md': 'base\n',
  }));
  writeFileSync(path.join(w.app, '.env.allowed'), 'allowed-secret\n');
  writeFileSync(path.join(w.app, '.env.other'), 'unselected-secret\n');
  writeFileSync(path.join(w.app, '.worktreeinclude'), '.env.other\n');
  const { tree } = await w.provision();
  await w.workspaces.write((store) => {
    store.bindCanvas(CANVAS, tree.repository);
    store.bind(CANVAS, 'builder', tree.id);
  });
  const spawn = vi.spyOn(SetupProcess, 'start');
  const service = (setups = new WorkspaceSetups({
    workspaces: w.workspaces,
    provisioner: w.provisioner,
    git: w.git,
    directories: { projectRoot: () => mintTrustedPath(w.app) },
    environment: () => Promise.resolve(w.env),
    processes: { run: (work) => work(), stop: () => Promise.resolve() },
    profile: w.profile,
    folder: path.join(w.profile, 'workspaces', 'setup'),
  }));
  await service.setCommand(CANVAS, 'echo approved');
  await service.prepare(tree.id);
  expect(readFileSync(path.join(tree.path, '.env.allowed'), 'utf8')).toBe('allowed-secret\n');
  expect(existsSync(path.join(tree.path, '.env.other'))).toBe(false);
  const need = service.items(CANVAS)[0];
  if (!need) throw new Error('Missing setup card');
  expect(need.detail).toContain('.env.allowed');
  expect(need.detail).not.toContain('allowed-secret');
  expect(need.detail).not.toContain('unselected-secret');
  for (const by of ['agent:builder', 'outside:runner'] as const)
    for (const choice of ['run', 'always', 'stop', 'skip'])
      await expect(service.reply(CANVAS, need.id, choice, by)).rejects.toThrow('Only the user');
  const document: CanvasDocument = {
    id: CANVAS,
    arrange: false,
    nodes: [{ id: 'builder', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Builder' } }],
    links: [],
  };
  const listed = listWorktrees(
    { workspaces: w.workspaces, projectRoot: () => w.app, kept: () => [] },
    CANVAS,
    document,
    { kind: 'token', reached: new Set(['builder']) },
  );
  expect(listed.items).toHaveLength(1);
  for (const field of ['location', 'need', 'setup', 'error'])
    expect(listed.items[0]).not.toHaveProperty(field);
  expect(listed.kept).toEqual([]);
  expect(w.workspaces.setup(tree.id)?.approvedBy).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});

it('does not replay an interrupted setup even when its exact command was allowed Always', async () => {
  const w = (fixture = await testWorkspaces());
  const { tree } = await w.provision();
  const spawn = vi.spyOn(SetupProcess, 'start');
  const service = (setups = new WorkspaceSetups({
    workspaces: w.workspaces,
    provisioner: w.provisioner,
    git: w.git,
    directories: { projectRoot: () => mintTrustedPath(w.app) },
    environment: () => Promise.resolve(w.env),
    processes: { run: (work) => work(), stop: () => Promise.resolve() },
    profile: w.profile,
    folder: path.join(w.profile, 'workspaces', 'setup'),
  }));
  await service.setCommand(CANVAS, 'echo approved');
  await service.prepare(tree.id);
  await w.workspaces.write((store) => {
    const pending = store.setup(tree.id);
    if (!pending) throw new Error('No setup');
    store.setAlways(tree.repository, pending.specHash);
    store.startSetup(tree.id, {
      generation: pending.generation,
      by: 'you',
      logKey: 'crash-attempt',
    });
  });
  await service.recover();
  await service.reconcile();
  expect(w.workspaces.setup(tree.id)?.state).toBe('interrupted');
  expect(w.workspaces.worktree(tree.id)?.state).toBe('setup');
  expect(service.items(CANVAS)).toHaveLength(1);
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses a kept-tree discard if a file changes while its confirmation waits', async () => {
  const w = (fixture = await testWorkspaces());
  const { tree } = await w.provision();
  const file = path.join(tree.path, 'README.md');
  writeFileSync(file, 'work before question\n');
  await w.workspaces.write((store) => {
    store.retain(tree.id);
  });
  const cleanup = new WorkspaceCleanup({ workspaces: w.workspaces, git: w.git });
  const offered = await cleanup.removeKept(CANVAS, tree.id);
  if (!('asks' in offered)) throw new Error('Expected a confirmation');
  writeFileSync(file, 'new work while deciding\n');
  await expect(
    cleanup.removeKept(CANVAS, tree.id, {
      choice: 'discard',
      fingerprints: { [tree.id]: fingerprint(offered.asks) },
    }),
  ).rejects.toThrow('changed since');
  expect(readFileSync(file, 'utf8')).toBe('new work while deciding\n');
  expect(w.workspaces.worktree(tree.id)?.state).toBe('retained');
});
