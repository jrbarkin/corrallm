import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintTrustedPath } from '../host';
import { discoverRepository } from './discovery';
import {
  checkInto,
  checkMergeable,
  checkSource,
  findDestination,
  selectSource,
} from './merge-select';
import type { MergeDestination, MergeRefusal, MergeSource, Selected } from './merge-select';
import type { RepositoryRecord, WorktreeRecord } from './store';
import { caseInsensitive, commit, git, listing, makeRepository } from './test-git';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * B9b's selectors (Design §9 C3), against real Git in throwaway repositories: the destination,
 * the branch your picked checkout is on, found again from the picked folder each time and checked
 * against the workspace's repository, minting nothing and writing nothing; and the source, the
 * agent's generated branch in its verified checkout, merged only from that branch, ready, with no
 * change waiting. A pin that differs from what the core reads now is a conflict.
 */

// Real Git, a repository and a worktree or two each: slower under load.
vi.setConfig({ testTimeout: 60_000 });

let made: TestWorkspaces;

beforeEach(async () => {
  made = await testWorkspaces({ 'README.md': 'hello\n', '.gitignore': '*.log\n' });
});
afterEach(async () => {
  await made.close();
});

const g = (cwd: string, ...args: string[]) => git(cwd, made.env, ...args).trim();

function value<T>(selected: Selected<T>): T {
  if (!selected.ok) throw new Error(`Refused: ${JSON.stringify(selected.refusal)}`);
  return selected.value;
}

function refusal<T>(selected: Selected<T>): MergeRefusal {
  if (selected.ok) throw new Error('It was selected.');
  return selected.refusal;
}

async function destination(
  picked = made.app,
  record?: RepositoryRecord,
): ReturnType<typeof findDestination> {
  return findDestination(made.git, {
    picked: mintTrustedPath(picked),
    repository: record ?? (await made.repository()),
  });
}

/** An agent of the canvas bound to a workspace of its own, ready, with its repository recorded. */
async function agent(
  name = 'builder',
): Promise<{ tree: WorktreeRecord; repository: RepositoryRecord }> {
  const { tree } = await made.provision(`agent/${name}`);
  const repository = await made.repository();
  await made.workspaces.write((w) => {
    w.bindCanvas(CANVAS, repository.id);
    w.bind(CANVAS, name, tree.id);
    w.transition(tree.id, { from: 'setup', to: 'ready' });
  });
  const kept = made.workspaces.worktree(tree.id);
  if (kept === undefined) throw new Error('No workspace.');
  return { tree: kept, repository };
}

/** Commits `files` in the checkout at `at`: its new HEAD. */
function work(at: string, files: Record<string, string>, message = 'work'): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
    writeFileSync(path.join(at, file), text);
  }
  g(at, 'add', '-A');
  commit(at, made.env, message);
  return g(at, 'rev-parse', 'HEAD');
}

const select = (agentId = 'builder', name = 'Builder') =>
  selectSource(
    { git: made.git, workspaces: made.workspaces },
    { canvas: CANVAS, agent: agentId, name },
  );

describe.skipIf(process.platform === 'win32')('the destination', () => {
  it('is the branch your picked checkout is on, at its commit, found again and checked, writing nothing', async () => {
    g(made.app, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    g(made.app, 'config', 'merge.ours.driver', 'true');
    const before = listing(made.app);
    const found = await destination();
    const into = value(found);
    expect(into).toMatchObject({
      root: made.app,
      gitDir: path.join(made.app, '.git'),
      commonDir: path.join(made.app, '.git'),
      branch: 'refs/heads/main',
      oid: made.base,
      drivers: ['lfs'],
      mergeDrivers: ['ours'],
      ignoreCase: caseInsensitive(),
    });
    expect(found.seen).toEqual({ ref: 'refs/heads/main', oid: made.base });
    expect(checkInto(into, { ref: 'refs/heads/main', oid: made.base })).toBeUndefined();
    // Nothing of the checkout or its Git directory changed; no workspaces' folder was made.
    expect(listing(made.app)).toEqual(before);
    expect(existsSync(path.join(made.app, '.corral'))).toBe(false);
  });

  it('is a linked pick’s own branch, Git directory and HEAD, the main checkout’s left alone', async () => {
    const linked = path.join(made.root, 'linked');
    g(made.app, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const recorded = await made.provisioner.repository(linked);
    if (recorded.kind !== 'repository') throw new Error(JSON.stringify(recorded));
    const into = value(await destination(linked, recorded.record));
    expect(into).toMatchObject({
      root: linked,
      gitDir: path.join(made.app, '.git', 'worktrees', 'linked'),
      commonDir: path.join(made.app, '.git'),
      branch: 'refs/heads/feature',
      oid: made.base,
    });
  });

  it('refuses a detached HEAD, saying what it is on', async () => {
    g(made.app, 'checkout', '-q', '--detach');
    const found = await destination();
    expect(refusal(found)).toMatchObject({ code: 'refused', reason: 'detached' });
    expect(found.seen).toEqual({ ref: null, oid: made.base });
  });

  it('refuses a branch that is a symbolic ref, naming the one HEAD names', async () => {
    g(made.app, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    g(made.app, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    const found = await destination();
    expect(refusal(found)).toMatchObject({ code: 'refused', reason: 'symbolic-branch' });
    expect(found.seen.ref).toBe('refs/heads/alias');
  });

  it('refuses one of corrallm’s own branches', async () => {
    g(made.app, 'switch', '-q', '-c', 'corrallm/mine');
    expect(refusal(await destination())).toMatchObject({
      code: 'refused',
      reason: 'corrallm-branch',
    });
  });

  it('refuses a branch checked out in another worktree too, unless that one’s folder is gone', async () => {
    const other = path.join(made.root, 'other');
    g(made.app, 'worktree', 'add', '-q', '-f', other, 'main');
    expect(refusal(await destination())).toMatchObject({
      code: 'refused',
      reason: 'checked-out-elsewhere',
    });
    rmSync(other, { recursive: true, force: true });
    expect(value(await destination()).branch).toBe('refs/heads/main');
  });

  it('refuses another repository at the picked folder, and a folder that is no repository', async () => {
    const record = await made.repository();
    rmSync(path.join(made.app, '.git'), { recursive: true, force: true });
    expect(refusal(await destination(made.app, record))).toMatchObject({
      code: 'unavailable',
      reason: 'not-git',
    });
    makeRepository(made.app, made.env);
    expect(refusal(await destination(made.app, record))).toMatchObject({
      code: 'unavailable',
      reason: 'repository-changed',
    });
  });

  it('refuses a picked folder discovery refuses, with discovery’s sentence', async () => {
    const record = await made.repository();
    g(made.app, 'config', 'core.worktree', made.root);
    const refused = refusal(await destination(made.app, record));
    expect(refused).toMatchObject({ code: 'unavailable', reason: 'discovery' });
    const discovered = await discoverRepository(made.git, made.app);
    expect(discovered.kind === 'refused' && discovered.sentence).toBe(refused.sentence);
  });

  it('pins: a branch moved or switched since you looked is a conflict', async () => {
    const into: MergeDestination = value(await destination());
    const moved = work(made.app, { 'more.txt': 'more\n' });
    const now = value(await destination());
    expect(now.oid).toBe(moved);
    expect(checkInto(now, { ref: 'refs/heads/main', oid: into.oid })).toMatchObject({
      code: 'conflict',
      reason: 'moved',
    });
    g(made.app, 'switch', '-q', '-c', 'dev');
    expect(
      checkInto(value(await destination()), { ref: 'refs/heads/main', oid: moved }),
    ).toMatchObject({ code: 'conflict', reason: 'moved' });
  });
});

describe.skipIf(process.platform === 'win32')('the source', () => {
  it('is the agent’s generated branch in its verified checkout, at its tip, on its branch', async () => {
    const { tree, repository } = await agent();
    const tip = work(tree.path, { 'agent.txt': 'agent\n' });
    const source: MergeSource = value(await select());
    expect(source).toMatchObject({
      canvas: CANVAS,
      agent: 'builder',
      ref: tree.branchRef,
      tip,
      onBranch: true,
      gitDir: path.join(repository.commonDir, 'worktrees', tree.id),
    });
    expect(String(source.cwd)).toBe(tree.path);
    expect(source.workspace.id).toBe(tree.id);
    expect(source.project).toMatchObject({ canvas: CANVAS, repository: repository.id });
    expect(checkMergeable(source)).toBeUndefined();
    expect(checkSource(source, { ref: tree.branchRef, oid: tip })).toBeUndefined();
  });

  it('pins: a tip or ref other than the one you saw is a conflict', async () => {
    const { tree } = await agent();
    const seen = work(tree.path, { 'agent.txt': 'agent\n' });
    work(tree.path, { 'agent.txt': 'agent, more\n' });
    const source = value(await select());
    expect(checkSource(source, { ref: tree.branchRef, oid: seen })).toMatchObject({
      code: 'conflict',
      reason: 'moved-source',
    });
    expect(checkSource(source, { ref: 'refs/heads/main', oid: source.tip })).toMatchObject({
      code: 'conflict',
      reason: 'moved-source',
    });
  });

  it('reviews an agent that switched its checkout to another branch or detached it, but never merges it', async () => {
    const { tree } = await agent();
    work(tree.path, { 'agent.txt': 'agent\n' });
    g(tree.path, 'switch', '-q', '-c', 'side');
    const side = value(await select());
    expect(side.onBranch).toBe(false);
    expect(side.ref).toBe(tree.branchRef);
    const refused = checkMergeable(side);
    expect(refused).toMatchObject({ code: 'refused', reason: 'off-branch' });
    expect(refused?.sentence).toMatch(/Builder/);
    g(tree.path, 'checkout', '-q', '--detach');
    expect(checkMergeable(value(await select()))).toMatchObject({ reason: 'off-branch' });
  });

  it('reviews a workspace with a change waiting, or not ready, but merges neither', async () => {
    const { tree } = await agent();
    await made.workspaces.write((w) => w.transition(tree.id, { from: 'ready', to: 'setup' }));
    expect(checkMergeable(value(await select()))).toMatchObject({
      code: 'unavailable',
      reason: 'not-ready',
    });
    await made.workspaces.write((w) => {
      w.transition(tree.id, { from: 'setup', to: 'ready' });
      w.plan(CANVAS, 'builder', 'agent/elsewhere');
    });
    const waiting = value(await select());
    expect(waiting.binding.desired).not.toBeNull();
    expect(checkMergeable(waiting)).toMatchObject({
      code: 'unavailable',
      reason: 'pending-change',
    });
  });

  it('refuses an agent with no workspace, one whose checkout doesn’t verify, and one on a project no longer picked', async () => {
    expect(refusal(await select('nobody', 'Nobody'))).toMatchObject({
      code: 'unavailable',
      reason: 'no-workspace',
    });
    const { tree } = await agent();
    await made.workspaces.write((w) => w.bindCanvas(CANVAS, null));
    expect(refusal(await select())).toMatchObject({
      code: 'unavailable',
      reason: 'project-changed',
    });
    await made.workspaces.write((w) => w.bindCanvas(CANVAS, tree.repository));
    rmSync(tree.path, { recursive: true, force: true });
    const gone = refusal(await select());
    expect(gone).toMatchObject({ code: 'unavailable', reason: 'checkout' });
    // Never a path in what a token may read.
    expect(gone.sentence).not.toContain(made.root);
  });

  it('refuses a generated branch that is a symbolic ref', async () => {
    const { tree } = await agent();
    g(tree.path, 'checkout', '-q', '--detach');
    g(made.app, 'symbolic-ref', tree.branchRef, 'refs/heads/main');
    g(tree.path, 'symbolic-ref', 'HEAD', tree.branchRef);
    expect(refusal(await select())).toMatchObject({ code: 'refused', reason: 'symbolic-source' });
  });
});
