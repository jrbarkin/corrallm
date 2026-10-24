import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { CanvasId } from '../../../shared/canvas';
import type { WorkspaceOwnerKey } from '../../../shared/model/workspaces';
import { CanvasMemory } from '../../memory';
import type { TrustedPath } from '../host';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { GitRunner } from './git';
import type { GitRunnerDeps } from './git';
import { Provisioner } from './provision';
import { WorkspaceStore } from './store';
import type { RepositoryRecord, WorktreeRecord } from './store';
import { gitEnvironment, makeRepository, scratch } from './test-git';

/*
 * For the workspaces' tests past provisioning (copying local files, setup): a throwaway profile
 * with its store, a real repository picked as a canvas's project folder, and workspaces made of it
 * by the real Provisioner, so each test starts from a checkout as C5 leaves it, in `setup`.
 */

export const CANVAS = '11111111-1111-4111-8111-111111111111' as CanvasId;
export const PROFILE_ID = '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';

export interface TestWorkspaces {
  root: string;
  /** The test's git environment: a home of its own, no user or system configuration. */
  env: Record<string, string>;
  /** The picked checkout, and its first commit. */
  app: string;
  base: string;
  /** The profile folder, its store and its workspace records. */
  profile: string;
  store: Store;
  workspaces: WorkspaceStore;
  runnerDeps: GitRunnerDeps;
  git: GitRunner;
  provisioner: Provisioner;
  repository(): Promise<RepositoryRecord>;
  /** A workspace made for `owner`, in `setup`, and its verified checkout. */
  provision(owner?: WorkspaceOwnerKey): Promise<{ tree: WorktreeRecord; cwd: TrustedPath }>;
  close(): Promise<void>;
}

/** A profile and a repository (its files committed once) for one test. */
export async function testWorkspaces(
  files: Record<string, string> = { 'README.md': 'hello\n' },
  extra: Partial<GitRunnerDeps> = {},
): Promise<TestWorkspaces> {
  const { root, remove } = scratch();
  const env = gitEnvironment(path.join(root, 'home'));
  const app = path.join(root, 'app');
  const base = makeRepository(app, env, files);
  const profile = path.join(root, 'profile');
  mkdirSync(profile);
  const store = await openTestStore(profile);
  const memory = new CanvasMemory(store);
  await store.write(() => {
    memory.ensure(CANVAS);
  });
  const workspaces = new WorkspaceStore({ store });
  const runnerDeps: GitRunnerDeps = {
    environment: () => Promise.resolve(env),
    hooks: path.join(profile, 'workspaces', 'hooks'),
    ...extra,
  };
  const git = new GitRunner(runnerDeps);
  const provisioner = new Provisioner({ workspaces, git, profile: PROFILE_ID });
  const repository = async () => {
    const found = await provisioner.repository(app);
    if (found.kind !== 'repository') throw new Error(JSON.stringify(found));
    return found.record;
  };
  return {
    root,
    env,
    app,
    base,
    profile,
    store,
    workspaces,
    runnerDeps,
    git,
    provisioner,
    repository,
    provision: async (owner = 'agent/builder') => {
      const tree = await provisioner.provision({
        canvas: CANVAS,
        repository: await repository(),
        owner,
      });
      const checkout = await provisioner.checkout(tree.id);
      if (checkout.state !== 'setup') throw new Error(`Not made: ${JSON.stringify(checkout)}`);
      return { tree: checkout.worktree, cwd: checkout.cwd };
    },
    close: async () => {
      await store.close();
      remove();
    },
  };
}
