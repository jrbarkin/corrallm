import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestStore } from '../store/test-store';
import { discoverRepository, recordRepository, repositoryIdentity } from './discovery';
import { WorkspaceStore } from './store';
import type { Discovery, FoundRepository } from './discovery';
import { GitRunner } from './git';
import { commit, git, gitEnvironment, makeRepository, scratch } from './test-git';

/*
 * Safe repository discovery (B9a Design §2, Repository discovery and authority): the picked
 * checkout's real top level, its own and common Git directories, identity and HEAD, refusing what
 * isn't the folder picked or can't be checked out safely, and never taking a failure to read a
 * repository for a folder that isn't one. Real Git, in throwaway folders.
 */

let root: string;
let remove: () => void;
let env: Record<string, string>;
let runner: GitRunner;

beforeEach(() => {
  ({ root, remove } = scratch());
  env = gitEnvironment(path.join(root, 'home'));
  runner = new GitRunner({
    environment: () => Promise.resolve(env),
    hooks: path.join(root, 'hooks'),
  });
});
afterEach(() => {
  remove();
});

function found(discovery: Discovery): FoundRepository {
  if (discovery.kind !== 'repository') throw new Error(JSON.stringify(discovery));
  return discovery.repository;
}

function refused(discovery: Discovery): string {
  if (discovery.kind !== 'refused') throw new Error(JSON.stringify(discovery));
  return discovery.reason;
}

describe.skipIf(process.platform === 'win32')('discoverRepository', () => {
  it('finds a checkout picked at its top level: its real paths, identity and HEAD', async () => {
    const at = path.join(root, 'app');
    const oid = makeRepository(at, env);
    const repository = found(await discoverRepository(runner, at));
    expect(repository).toEqual({
      pickedRoot: at,
      realRoot: at,
      gitDir: path.join(at, '.git'),
      commonDir: path.join(at, '.git'),
      identity: repositoryIdentity(path.join(at, '.git')),
      head: { ref: 'refs/heads/main', oid },
      drivers: [],
    });
    expect(found(await discoverRepository(runner, at)).identity).toBe(repository.identity);
  });

  it('records the real path of a checkout picked through a symlink', async () => {
    const at = path.join(root, 'app');
    makeRepository(at, env);
    const link = path.join(root, 'link');
    symlinkSync(at, link);
    const repository = found(await discoverRepository(runner, link));
    expect(repository.pickedRoot).toBe(link);
    expect(repository.realRoot).toBe(at);
  });

  it('says a folder that isn’t a repository is none, but never one Git couldn’t read', async () => {
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    expect(await discoverRepository(runner, plain)).toEqual({ kind: 'not-git' });
    // A .git Git can't read as a repository is not evidence there is none.
    const broken = path.join(root, 'broken');
    mkdirSync(path.join(broken, '.git'), { recursive: true });
    expect(refused(await discoverRepository(runner, broken))).toBe('unsupported');
    expect(refused(await discoverRepository(runner, path.join(root, 'gone')))).toBe('missing');
  });

  it('never widens a folder inside a repository to the whole repository', async () => {
    const at = path.join(root, 'app');
    makeRepository(at, env, { 'src/a.ts': 'a\n' });
    const discovery = await discoverRepository(runner, path.join(at, 'src'));
    expect(refused(discovery)).toBe('subdirectory');
    expect(discovery.kind === 'refused' && discovery.sentence).toContain(at);
  });

  it('holds a repository with no commit, and finds a detached HEAD’s commit', async () => {
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    git(empty, env, 'init', '-q');
    expect(refused(await discoverRepository(runner, empty))).toBe('no-commit');
    const at = path.join(root, 'app');
    const oid = makeRepository(at, env);
    git(at, env, 'checkout', '-q', '--detach');
    expect(found(await discoverRepository(runner, at)).head).toEqual({ ref: null, oid });
  });

  it('supports a picked linked worktree: it, not the main checkout, is the base', async () => {
    const at = path.join(root, 'app');
    const oid = makeRepository(at, env);
    const linked = path.join(root, 'linked');
    git(at, env, 'worktree', 'add', '-q', '-b', 'side', linked);
    const repository = found(await discoverRepository(runner, linked));
    expect(repository).toMatchObject({
      realRoot: linked,
      gitDir: path.join(at, '.git', 'worktrees', 'linked'),
      commonDir: path.join(at, '.git'),
      head: { ref: 'refs/heads/side', oid },
    });
  });

  it('refuses a .git that is a symlink, or a file pointing at another checkout', async () => {
    const victim = path.join(root, 'victim');
    makeRepository(victim, env);
    const before = readFileSync(path.join(victim, '.git', 'info', 'exclude'), 'utf8');
    const linked = path.join(root, 'linked-git');
    mkdirSync(linked);
    symlinkSync(path.join(victim, '.git'), path.join(linked, '.git'));
    expect(refused(await discoverRepository(runner, linked))).toBe('redirected');
    const forged = path.join(root, 'forged');
    mkdirSync(forged);
    writeFileSync(path.join(forged, '.git'), `gitdir: ${path.join(victim, '.git')}\n`);
    expect(refused(await discoverRepository(runner, forged))).toBe('redirected');
    // A linked worktree's .git naming another worktree's registration doesn't agree with it.
    const real = path.join(root, 'real-linked');
    git(victim, env, 'worktree', 'add', '-q', '-b', 'side', real);
    const impostor = path.join(root, 'impostor');
    mkdirSync(impostor);
    writeFileSync(
      path.join(impostor, '.git'),
      `gitdir: ${path.join(victim, '.git', 'worktrees', 'real-linked')}\n`,
    );
    expect(refused(await discoverRepository(runner, impostor))).toBe('redirected');
    // Nothing of the victim changed.
    expect(readFileSync(path.join(victim, '.git', 'info', 'exclude'), 'utf8')).toBe(before);
    expect(readdirSync(path.join(victim, '.git', 'worktrees'))).toEqual(['real-linked']);
  });

  it('refuses a checkout core.worktree redirects, and configuration it can’t neutralize', async () => {
    const at = path.join(root, 'app');
    makeRepository(at, env);
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    git(at, env, 'config', 'core.worktree', elsewhere);
    expect(refused(await discoverRepository(runner, at))).toBe('redirected');
    git(at, env, 'config', '--unset', 'core.worktree');
    git(at, env, 'config', 'hook.audit.command', 'evil');
    expect(refused(await discoverRepository(runner, at))).toBe('config');
  });

  it('says Git is missing rather than that the folder isn’t a repository', async () => {
    const at = path.join(root, 'app');
    makeRepository(at, env);
    env = { ...env, PATH: path.join(root, 'nothing') };
    expect(refused(await discoverRepository(runner, at))).toBe('git-missing');
  });

  it('gives a repository made again at the same path another identity', async () => {
    const at = path.join(root, 'app');
    makeRepository(at, env);
    const first = found(await discoverRepository(runner, at)).identity;
    // The old repository, moved aside, keeps its inode: the new one can't reuse its number.
    renameSync(path.join(at, '.git'), path.join(root, 'old-git'));
    git(at, env, 'init', '-q', '-b', 'main');
    git(at, env, 'add', '-A');
    commit(at, env, 'again');
    expect(found(await discoverRepository(runner, at)).identity).not.toBe(first);
  });

  it('records the repository by its real path and identity, never moving its workspaces’ folder', async () => {
    const at = path.join(root, 'app');
    makeRepository(at, env);
    const link = path.join(root, 'link');
    symlinkSync(at, link);
    mkdirSync(path.join(root, 'profile'));
    const store = await openTestStore(path.join(root, 'profile'));
    try {
      const workspaces = new WorkspaceStore({ store });
      const repository = found(await discoverRepository(runner, at));
      const kept = await workspaces.write((w) =>
        recordRepository(w, repository, { profile: PROFILE, id: REPOSITORY }),
      );
      expect(kept).toEqual({
        id: REPOSITORY,
        pickedRoot: at,
        realRoot: at,
        commonDir: path.join(at, '.git'),
        identity: repository.identity,
        rootKind: 'project',
        ownedRoot: path.join(at, '.corral', 'worktrees', PROFILE),
        generation: 0,
      });
      // Found again through a link, by another profile id: the same record, its folder kept.
      const again = found(await discoverRepository(runner, link));
      expect(
        await workspaces.write((w) =>
          recordRepository(w, again, { profile: OTHER_PROFILE, id: OTHER_REPOSITORY }),
        ),
      ).toEqual({ ...kept, pickedRoot: link, generation: 1 });
      // A new one's folder is named by the profile's id, which is never a path.
      const other = path.join(root, 'other');
      makeRepository(other, env);
      const another = found(await discoverRepository(runner, other));
      expect(() =>
        recordRepository(workspaces, another, { profile: '../escape', id: OTHER_REPOSITORY }),
      ).toThrow();
    } finally {
      await store.close();
    }
  });
});

const PROFILE = '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_PROFILE = '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5c';
const REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e70';
const OTHER_REPOSITORY = '7c0e9a1e-1b6f-4b4f-9f3a-2d1c0b9a8e71';
