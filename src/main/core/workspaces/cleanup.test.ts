import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fingerprint, safe, WorkspaceCleanup } from './cleanup';
import type { Removal } from './cleanup';
import type { WorktreeRecord } from './store';
import { commit, git } from './test-git';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * A workspace's cleanup (B9a C7, workspaces/cleanup.ts), against real Git in throwaway folders:
 * what a tree holds, removed only once it is still what was decided (safe, or the fingerprint you
 * approved), never work added since; its branch deleted only where it was; what fails kept
 * `removing`, saying why, and tried again.
 */

let made: TestWorkspaces;
let writers: string[];
let forgotten: string[];

beforeEach(async () => {
  made = await testWorkspaces();
  writers = [];
  forgotten = [];
});

afterEach(async () => {
  await made.close();
});

function cleanup(): WorkspaceCleanup {
  return new WorkspaceCleanup({
    workspaces: made.workspaces,
    git: made.git,
    writers: () => writers,
    forgetSetup: (workspace) => {
      forgotten.push(workspace);
      return Promise.resolve();
    },
    nameOf: (_canvas, owner) => (owner === 'agent/builder' ? 'Builder' : undefined),
    settleMs: 50,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
}

/** A workspace provisioned, then kept (its agent gone), as a delete leaves one before cleanup. */
async function kept(): Promise<WorktreeRecord> {
  const { tree } = await made.provision();
  return made.workspaces.write((w) => w.retain(tree.id));
}

/** Marks the workspace removing as decided, in a write of its own. */
async function decide(service: WorkspaceCleanup, tree: WorktreeRecord, removal: Removal) {
  await made.workspaces.write((w) => {
    service.intend(w, tree.id, removal);
  });
}

/** Every path below `at`, with what each file holds: what a write through a link would change. */
function snapshot(at: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of readdirSync(at, { recursive: true, encoding: 'utf8' }).sort()) {
    const file = path.join(at, name);
    found[name] = statSync(file).isDirectory() ? '/' : readFileSync(file, 'utf8');
  }
  return found;
}

function branchAt(ref: string): string | undefined {
  try {
    return git(made.app, made.env, 'rev-parse', '--verify', '--quiet', ref).trim();
  } catch {
    return undefined;
  }
}

describe('what a tree holds', { timeout: 60_000 }, () => {
  it('is safe only clean, merged and with no one writing there', async () => {
    const service = cleanup();
    const tree = await kept();
    const clean = await service.assess(tree);
    expect(clean).toMatchObject({ changed: 0, untracked: 0, merged: true, writers: [] });
    expect(clean.unknown).toBeUndefined();
    expect(safe(clean)).toBe(true);
    // The same tree read again: the same fingerprint.
    expect(fingerprint(await service.assess(tree))).toBe(fingerprint(clean));

    writers = ['builder'];
    expect(safe(await service.assess(tree))).toBe(false);
    writers = [];

    writeFileSync(path.join(tree.path, 'notes.md'), 'draft\n');
    writeFileSync(path.join(tree.path, 'README.md'), 'changed\n');
    const dirty = await service.assess(tree);
    expect(dirty).toMatchObject({ changed: 1, untracked: 1, merged: true });
    expect([...dirty.paths].sort()).toEqual(['README.md', 'notes.md']);
    expect(safe(dirty)).toBe(false);
    expect(fingerprint(dirty)).not.toBe(fingerprint(clean));

    // A commit of its own the picked checkout doesn't have: not merged, whatever its files.
    git(tree.path, made.env, 'add', '-A');
    commit(tree.path, made.env, 'work');
    const committed = await service.assess(tree);
    expect(committed).toMatchObject({ changed: 0, untracked: 0, merged: false });
    expect(safe(committed)).toBe(false);
  });

  it('says it can’t tell, never safe, when its checkout is gone', async () => {
    const service = cleanup();
    const tree = await kept();
    rmSync(tree.path, { recursive: true, force: true });
    const gone = await service.assess(tree);
    expect(gone.unknown).toMatch(/gone/);
    expect(gone.tip).toBe(made.base);
    expect(safe(gone)).toBe(false);
  });
});

describe('removing a tree', { timeout: 60_000 }, () => {
  it('removes a safe tree, its branch and what its setup kept, and forgets its record', async () => {
    const service = cleanup();
    const tree = await kept();
    await decide(service, tree, { branch: true, force: false, approved: null, tip: made.base });
    expect(made.workspaces.worktree(tree.id)?.state).toBe('removing');
    expect(await service.remove(tree.id)).toBe('removed');
    expect(existsSync(tree.path)).toBe(false);
    expect(branchAt(tree.branchRef)).toBeUndefined();
    expect(made.workspaces.worktree(tree.id)).toBeUndefined();
    expect(forgotten).toEqual([tree.id]);
    // Git no longer lists it, and the picked checkout is as it was.
    expect(git(made.app, made.env, 'worktree', 'list', '--porcelain')).not.toContain(tree.id);
    expect(git(made.app, made.env, 'status', '--porcelain')).toBe('');
  });

  it('removes a discard you approved, and keeps one changed since, with its work', async () => {
    const service = cleanup();
    const tree = await kept();
    writeFileSync(path.join(tree.path, 'notes.md'), 'draft\n');
    const approved = fingerprint(await service.assess(tree));
    // Something writes there after you approved: the tree is kept, never its work lost.
    await decide(service, tree, { branch: true, force: true, approved, tip: made.base });
    writeFileSync(path.join(tree.path, 'later.md'), 'added while you decided\n');
    expect(await service.remove(tree.id)).toBe('retained');
    expect(made.workspaces.worktree(tree.id)).toMatchObject({ state: 'retained', errorCode: null });
    expect(existsSync(path.join(tree.path, 'later.md'))).toBe(true);
    expect(branchAt(tree.branchRef)).toBe(made.base);
    expect(forgotten).toEqual([]);
    // Approved again as it is now: removed, files and all.
    const now = fingerprint(await service.assess(made.workspaces.worktree(tree.id) ?? tree));
    await decide(service, tree, { branch: true, force: true, approved: now, tip: made.base });
    expect(await service.remove(tree.id)).toBe('removed');
    expect(existsSync(tree.path)).toBe(false);
    expect(made.workspaces.worktree(tree.id)).toBeUndefined();
  });

  it('keeps a discard approved before a file it holds was written again, with its work', async () => {
    const service = cleanup();
    const tree = await kept();
    writeFileSync(path.join(tree.path, 'notes.md'), 'draft\n');
    writeFileSync(path.join(tree.path, 'README.md'), 'changed\n');
    const asked = await service.assess(tree);
    await decide(service, tree, {
      branch: true,
      force: true,
      approved: fingerprint(asked),
      tip: made.base,
    });
    // The same files written again while you decided: Git's status of them is as it was, but
    // what they hold isn't, so the tree is kept with that work.
    appendFileSync(path.join(tree.path, 'notes.md'), 'more, written while you decided\n');
    writeFileSync(path.join(tree.path, 'README.md'), 'CHANGED\n');
    expect(fingerprint(await service.assess(tree))).not.toBe(fingerprint(asked));
    expect(await service.remove(tree.id)).toBe('retained');
    expect(readFileSync(path.join(tree.path, 'notes.md'), 'utf8')).toContain('more');
    expect(readFileSync(path.join(tree.path, 'README.md'), 'utf8')).toBe('CHANGED\n');
    // Read again as it is, untouched: the same fingerprint.
    const now = await service.assess(made.workspaces.worktree(tree.id) ?? tree);
    expect(fingerprint(await service.assess(tree))).toBe(fingerprint(now));
  });

  it('removes a kept tree you chose to discard while a session was still closing there, once it has', async () => {
    const service = cleanup();
    const tree = await kept();
    writeFileSync(path.join(tree.path, 'notes.md'), 'draft\n');
    // A session whose bounded close hadn't finished as you were asked: it is a writer there.
    writers = ['builder'];
    const asked = await service.assess(tree);
    expect(asked.writers).toEqual(['builder']);
    const decision = {
      choice: 'discard' as const,
      fingerprints: { [tree.id]: fingerprint(asked) },
    };
    // It finishes closing as the removal waits for it, having written nothing more.
    setTimeout(() => {
      writers = [];
    }, 10);
    expect(await service.removeKept(CANVAS, tree.id, decision)).toEqual({ removed: true });
    expect(existsSync(tree.path)).toBe(false);
    expect(made.workspaces.worktree(tree.id)).toBeUndefined();
  });

  it('keeps a branch moved since it was decided, removing only the tree', async () => {
    const service = cleanup();
    const tree = await kept();
    const approved = fingerprint(await service.assess(tree));
    await decide(service, tree, { branch: true, force: true, approved, tip: 'f'.repeat(40) });
    expect(await service.remove(tree.id)).toBe('removed');
    expect(existsSync(tree.path)).toBe(false);
    expect(branchAt(tree.branchRef)).toBe(made.base);
  });

  it('keeps a branch checked out in another checkout, removing only the tree', async () => {
    const service = cleanup();
    const tree = await kept();
    // Its agent moved its tree to a branch of its own, at the same commit; you then checked its
    // generated branch out in the picked checkout, to look at it.
    git(tree.path, made.env, 'switch', '--quiet', '-c', 'elsewhere');
    const branch = tree.branchRef.slice('refs/heads/'.length);
    git(made.app, made.env, 'switch', '--quiet', branch);
    const state = await service.assess(tree);
    expect(safe(state)).toBe(true);
    await decide(service, tree, { branch: true, force: false, approved: null, tip: state.tip });
    expect(await service.remove(tree.id)).toBe('removed');
    expect(existsSync(tree.path)).toBe(false);
    // The checkout on it is still on a branch that is there, at its commit.
    expect(branchAt(tree.branchRef)).toBe(made.base);
    expect(git(made.app, made.env, 'rev-parse', '--verify', 'HEAD').trim()).toBe(made.base);
  });

  it('keeps a tree that turned unsafe as removing waited, rather than remove it as safe', async () => {
    const service = cleanup();
    const tree = await kept();
    await decide(service, tree, { branch: true, force: false, approved: null, tip: made.base });
    writeFileSync(path.join(tree.path, 'notes.md'), 'draft\n');
    expect(await service.remove(tree.id)).toBe('retained');
    expect(existsSync(path.join(tree.path, 'notes.md'))).toBe(true);
  });

  it('waits for its writers a while, then leaves it removing, saying why, for later', async () => {
    const service = cleanup();
    const tree = await kept();
    await decide(service, tree, { branch: true, force: false, approved: null, tip: made.base });
    writers = ['builder'];
    expect(await service.remove(tree.id)).toBe('waiting');
    expect(made.workspaces.worktree(tree.id)).toMatchObject({
      state: 'removing',
      errorCode: 'cleanup-writing',
    });
    expect(existsSync(tree.path)).toBe(true);
    // Tried again as the core next starts: its writer gone by then.
    writers = [];
    await service.reconcile();
    expect(made.workspaces.worktree(tree.id)).toBeUndefined();
    expect(existsSync(tree.path)).toBe(false);
  });

  it('never removes what isn’t the checkout it made: a folder put in its place stays', async () => {
    const service = cleanup();
    const tree = await kept();
    const approved = fingerprint(await service.assess(tree));
    await decide(service, tree, { branch: true, force: true, approved, tip: made.base });
    // Its folder replaced by a link to the picked checkout.
    rmSync(tree.path, { recursive: true, force: true });
    symlinkSync(made.app, tree.path);
    expect(await service.remove(tree.id)).toBe('retained');
    expect(existsSync(path.join(made.app, 'README.md'))).toBe(true);
    // Approved as it is now, still: it isn't the checkout, so nothing there is removed.
    const now = fingerprint(await service.assess(made.workspaces.worktree(tree.id) ?? tree));
    await decide(service, tree, { branch: true, force: true, approved: now, tip: made.base });
    expect(await service.remove(tree.id)).toBe('failed');
    expect(made.workspaces.worktree(tree.id)).toMatchObject({
      state: 'removing',
      errorCode: 'cleanup-checkout-changed',
    });
    expect(existsSync(path.join(made.app, 'README.md'))).toBe(true);
  });

  /*
   * What removal writes in the common Git directory (the registration it deletes, the branch's
   * loose ref, reflog and packed-refs) is never reached through a link: a removal finding one
   * removes nothing, here or there, and stays removing, saying why.
   */
  it.each(['worktrees', 'refs/heads/corrallm', 'logs/refs/heads/corrallm', 'packed-refs'])(
    'removes nothing through a symlinked %s of the common Git directory',
    async (at) => {
      const service = cleanup();
      const tree = await kept();
      await decide(service, tree, { branch: true, force: false, approved: null, tip: made.base });
      if (at === 'packed-refs') git(made.app, made.env, 'pack-refs', '--all');
      const outside = path.join(made.root, 'outside');
      mkdirSync(outside);
      const moved = path.join(outside, 'moved');
      const linked = path.join(made.app, '.git', at);
      renameSync(linked, moved);
      symlinkSync(moved, linked);
      const before = snapshot(outside);
      const ended = await service.remove(tree.id);
      expect(snapshot(outside)).toEqual(before);
      expect(ended).toBe('failed');
      expect(made.workspaces.worktree(tree.id)).toMatchObject({
        state: 'removing',
        errorCode: 'cleanup-git-metadata-symlinked',
      });
      expect(existsSync(path.join(tree.path, 'README.md'))).toBe(true);
      expect(branchAt(tree.branchRef)).toBe(made.base);
    },
  );

  it('forgets a tree whose checkout is gone once you approved it, its branch with it', async () => {
    const service = cleanup();
    const tree = await kept();
    mkdirSync(path.join(made.root, 'elsewhere'));
    rmSync(tree.path, { recursive: true, force: true });
    const approved = fingerprint(await service.assess(tree));
    await decide(service, tree, { branch: true, force: true, approved, tip: made.base });
    expect(await service.remove(tree.id)).toBe('removed');
    expect(made.workspaces.worktree(tree.id)).toBeUndefined();
    expect(branchAt(tree.branchRef)).toBeUndefined();
  });
});

describe('kept trees', { timeout: 60_000 }, () => {
  it('lists every tree kept or being removed, with whose it was, its branch and state', async () => {
    const service = cleanup();
    const first = await kept();
    const { tree: inUse } = await made.provision('agent/reviewer');
    const listed = service.kept(CANVAS);
    expect(listed).toEqual([
      expect.objectContaining({
        workspace: first.id,
        canvas: CANVAS,
        owner: 'agent/builder',
        name: 'Builder',
        branch: first.branchRef.slice('refs/heads/'.length),
        base: { ref: 'refs/heads/main', oid: made.base },
        state: 'retained',
        error: null,
      }),
    ]);
    expect(listed.map(({ workspace }) => workspace)).not.toContain(inUse.id);
    const changed = vi.fn();
    const told = new WorkspaceCleanup({
      workspaces: made.workspaces,
      git: made.git,
      changed,
      settleMs: 0,
    });
    await decide(told, first, { branch: false, force: false, approved: null, tip: null });
    expect(told.kept()[0]).toMatchObject({ state: 'removing' });
    await told.remove(first.id);
    expect(told.kept()).toEqual([]);
    expect(changed).toHaveBeenCalledWith(CANVAS);
    // Its branch kept, as decided.
    expect(branchAt(first.branchRef)).toBe(made.base);
  });
});
