import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { GitRunner } from './git';
import type { GitCall, GitOutput, GitRunnerDeps } from './git';
import { EXCLUDED, ensureOwnedRoot } from './owned';
import { CREATE_PHASES, ProvisionError, Provisioner } from './provision';
import type { ProvisionerDeps } from './provision';
import { ProvisioningQueue } from './queue';
import { WorkspaceStore } from './store';
import type { RepositoryRecord, WorktreeRecord } from './store';
import {
  commit,
  git,
  gitEnvironment,
  makeRepository,
  ran,
  scratch,
  sentinelProgram,
} from './test-git';

/*
 * Provisioning (B9a Design §3, Provisioning protocol): a workspace's intent recorded first, then
 * its checkout made in the repository's lane of the queue (its branch from the picked checkout's
 * HEAD, a worktree registered without a checkout, then populated, every phase marked on disk),
 * verified, and handed to setup; reused by its owner's every start; finished on restart from what
 * Git actually has, never made twice; and a checkout lost or changed noticed before its path is
 * trusted. Real Git in throwaway repositories, a real store in a throwaway profile.
 */

const CANVAS = '11111111-1111-4111-8111-111111111111' as CanvasId;
const PROFILE = '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const OWNER = 'agent/builder' as const;

let root: string;
let remove: () => void;
let env: Record<string, string>;
let app: string;
let base: string;
let profile: string;
let store: Store;
let workspaces: WorkspaceStore;

beforeEach(async () => {
  ({ root, remove } = scratch());
  env = gitEnvironment(path.join(root, 'home'));
  app = path.join(root, 'app');
  base = makeRepository(app, env, { 'README.md': 'hello\n', 'src/main.ts': 'export {};\n' });
  profile = path.join(root, 'profile');
  mkdirSync(profile);
  store = await openTestStore(profile);
  const memory = new CanvasMemory(store);
  await store.write(() => {
    memory.ensure(CANVAS);
  });
  workspaces = new WorkspaceStore({ store });
});
afterEach(async () => {
  await store.close();
  remove();
});

function runnerDeps(): GitRunnerDeps {
  return {
    environment: () => Promise.resolve(env),
    hooks: path.join(profile, 'workspaces', 'hooks'),
  };
}

/** A runner that records every call it makes. */
class Recording extends GitRunner {
  readonly calls: GitCall[] = [];
  override run(call: GitCall): Promise<GitOutput> {
    this.calls.push(call);
    return super.run(call);
  }
  count(...command: string[]): number {
    return this.calls.filter((call) => command.every((part, i) => call.args[i] === part)).length;
  }
}

/** A runner whose core dies at the call `when` matches: before it runs, or once it has. */
class Crashing extends GitRunner {
  readonly crashed = Promise.withResolvers<undefined>();
  readonly #when: (call: GitCall) => boolean;
  readonly #after: boolean;
  constructor(when: (call: GitCall) => boolean, after: boolean) {
    super(runnerDeps());
    this.#when = when;
    this.#after = after;
  }
  override async run(call: GitCall): Promise<GitOutput> {
    if (!this.#when(call)) return super.run(call);
    if (this.#after) await super.run(call);
    this.crashed.resolve(undefined);
    // The core is gone: nothing after this point runs.
    return new Promise<never>(() => undefined);
  }
}

function provisioner(deps: Partial<ProvisionerDeps> = {}): Provisioner {
  return new Provisioner({
    workspaces,
    git: new GitRunner(runnerDeps()),
    profile: PROFILE,
    ...deps,
  });
}

async function repositoryOf(p: Provisioner): Promise<RepositoryRecord> {
  const found = await p.repository(app);
  if (found.kind !== 'repository') throw new Error(JSON.stringify(found));
  return found.record;
}

/** The worktrees Git has registered for the picked checkout, by path. */
function registered(): string[] {
  return git(app, env, 'worktree', 'list', '--porcelain', '-z')
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
    .sort();
}

/** The workspace kept by that id. */
function kept(id: string): WorktreeRecord {
  const tree = workspaces.worktree(id);
  if (tree === undefined) throw new Error(`No workspace ${id}.`);
  return tree;
}

/** The branches corrallm made, with their commits. */
function branches(): string[] {
  return git(app, env, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/corrallm/')
    .split('\n')
    .filter(Boolean);
}

/** Everything in a checkout but its `.git`: each folder, and each file with what it holds. */
function contents(at: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (folder: string, prefix: string) => {
    for (const name of readdirSync(folder).sort()) {
      if (prefix === '' && name === '.git') continue;
      const file = path.join(folder, name);
      const relative = `${prefix}${name}`;
      if (statSync(file).isDirectory()) {
        found[`${relative}/`] = '';
        walk(file, `${relative}/`);
      } else found[relative] = readFileSync(file, 'utf8');
    }
  };
  walk(at, '');
  return found;
}

/** A workspace made as it should be: its branch at the base, registered, populated and clean. */
function expectMade(tree: WorktreeRecord): void {
  expect(tree.state).toBe('setup');
  expect(registered()).toEqual([app, tree.path]);
  expect(branches()).toEqual([`${tree.branchRef} ${base}`]);
  expect(readFileSync(path.join(tree.path, 'README.md'), 'utf8')).toBe('hello\n');
  expect(readFileSync(path.join(tree.path, 'src', 'main.ts'), 'utf8')).toBe('export {};\n');
  expect(git(tree.path, env, 'status', '--porcelain')).toBe('');
  expect(git(tree.path, env, 'symbolic-ref', 'HEAD').trim()).toBe(tree.branchRef);
}

describe.skipIf(process.platform === 'win32')('Provisioner', () => {
  it('makes a workspace’s checkout: its own branch from the picked HEAD, registered, populated, excluded, then setup’s', async () => {
    const changed = vi.fn();
    const p = provisioner({ changed });
    const repository = await repositoryOf(p);
    expect(repository.ownedRoot).toBe(path.join(app, '.corral', 'worktrees', PROFILE));
    // Work in the picked checkout that isn't committed isn't the new workspace's.
    writeFileSync(path.join(app, 'README.md'), 'edited, not committed\n');
    writeFileSync(path.join(app, 'scratch.txt'), 'untracked\n');
    const tree = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
    expect(tree).toMatchObject({
      canvas: CANVAS,
      repository: repository.id,
      owner: OWNER,
      path: path.join(repository.ownedRoot, tree.id),
      branchRef: `refs/heads/corrallm/${PROFILE}/${tree.id}`,
      baseCheckout: app,
      baseRef: 'refs/heads/main',
      baseOid: base,
      forkedFrom: null,
      state: 'setup',
    });
    expectMade(tree);
    // Its job went through every phase, its intent kept.
    const [job] = workspaces.jobsOf(tree.id);
    expect(job).toMatchObject({ kind: 'create', phase: 'populated', outcome: 'done' });
    expect(CREATE_PHASES).toEqual(['recorded', 'branch', 'registered', 'populated']);
    // The picked checkout is as it was, but for the line that keeps the workspaces out of it.
    expect(readFileSync(path.join(app, 'README.md'), 'utf8')).toBe('edited, not committed\n');
    expect(git(app, env, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(git(app, env, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    expect(git(app, env, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M README.md',
      '?? scratch.txt',
    ]);
    expect(readFileSync(path.join(app, '.git', 'info', 'exclude'), 'utf8')).toContain(
      `${EXCLUDED}\n`,
    );
    expect(changed).toHaveBeenCalledWith(CANVAS);
    // Its verified path is minted for its agents.
    const checkout = await p.checkout(tree.id);
    expect(checkout).toMatchObject({ state: 'setup', branch: tree.branchRef });
    expect(checkout.state === 'setup' && checkout.cwd).toBe(tree.path);
  });

  it('reuses an owner’s workspace: ten simultaneous starts make one checkout', async () => {
    const git2 = new Recording(runnerDeps());
    const p = provisioner({ git: git2 });
    const repository = await repositoryOf(p);
    const trees = await Promise.all(
      Array.from({ length: 10 }, () => p.provision({ canvas: CANVAS, repository, owner: OWNER })),
    );
    expect(new Set(trees.map(({ id }) => id)).size).toBe(1);
    const again = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
    expect(again.id).toBe(trees[0]?.id);
    expect(git2.count('update-ref')).toBe(1);
    expect(git2.count('worktree', 'add')).toBe(1);
    expect(git2.count('read-tree')).toBe(1);
    expectMade(again);
    // Another owner gets another.
    const other = await p.provision({ canvas: CANVAS, repository, owner: 'group/team' });
    expect(other.id).not.toBe(again.id);
    expect(registered()).toEqual([app, again.path, other.path].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('creates nothing twice for a retry of the same intent', async () => {
    const git2 = new Recording(runnerDeps());
    const p = provisioner({ git: git2 });
    const repository = await repositoryOf(p);
    const tree = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
    const [job] = workspaces.jobsOf(tree.id);
    if (job === undefined) throw new Error('No job.');
    // Recorded again as it was: the job recorded, ended, and nothing run again.
    const again = await workspaces.write((w) =>
      w.recordJob({
        id: job.id,
        workspace: job.workspace,
        kind: job.kind,
        phase: 'recorded',
        generation: job.generation,
        expectedIdentity: job.expectedIdentity,
        payload: job.payload,
      }),
    );
    expect(again).toEqual(job);
    const before = git2.calls.length;
    expect((await p.run(job.id)).state).toBe('setup');
    expect(git2.calls.length).toBe(before);
    // The intent recorded again within another write finds the owner's workspace.
    const intended = await workspaces.write((w) =>
      p.intend(w, {
        canvas: CANVAS,
        repository,
        owner: OWNER,
        base: { checkout: app, ref: 'refs/heads/main', oid: base },
      }),
    );
    expect(intended).toMatchObject({ created: false, worktree: { id: tree.id }, job: undefined });
    expect(workspaces.jobsOf(tree.id)).toHaveLength(1);
    expectMade(kept(tree.id));
  });

  describe('restart', { timeout: 60_000 }, () => {
    const at =
      (command: string, sub?: string) =>
      (call: GitCall): boolean =>
        call.args[0] === command && (sub === undefined || call.args[1] === sub);
    const cases: {
      name: string;
      when: (call: GitCall) => boolean;
      after: boolean;
      phase: string;
      damage?: (tree: WorktreeRecord) => void;
      redone: { command: string[]; times: number }[];
    }[] = [
      {
        name: 'before its branch is made',
        when: at('update-ref'),
        after: false,
        phase: 'recorded',
        redone: [{ command: ['update-ref'], times: 1 }],
      },
      {
        name: 'once its branch is made, before that is recorded',
        when: at('update-ref'),
        after: true,
        phase: 'recorded',
        redone: [
          { command: ['update-ref'], times: 0 },
          { command: ['worktree', 'add'], times: 1 },
        ],
      },
      {
        name: 'once its worktree is registered, before that is recorded',
        when: at('worktree', 'add'),
        after: true,
        phase: 'branch',
        redone: [
          { command: ['update-ref'], times: 0 },
          { command: ['worktree', 'add'], times: 0 },
          { command: ['read-tree'], times: 1 },
        ],
      },
      {
        name: 'once it is populated, before that is recorded (nothing changed there since)',
        when: at('read-tree'),
        after: true,
        phase: 'registered',
        redone: [
          { command: ['worktree', 'add'], times: 0 },
          { command: ['read-tree'], times: 0 },
        ],
      },
      {
        name: 'once it is populated and that recorded, before it is ready for setup',
        when: (call) =>
          call.args[0] === 'rev-parse' && workspaces.openJobs()[0]?.phase === 'populated',
        after: false,
        phase: 'populated',
        redone: [
          { command: ['worktree', 'add'], times: 0 },
          { command: ['read-tree'], times: 0 },
        ],
      },
    ];

    /*
     * A population the core didn't mark may have been changed while it was stopped: by you, by
     * anything running as you. It is adopted only when it is exactly what Git wrote, else held for
     * you, its files as they are: never populated again over them, by a restart or your retry.
     */
    const changes: {
      name: string;
      before?: () => void;
      change: (tree: WorktreeRecord, registration: string) => void;
    }[] = [
      {
        name: 'a tracked file edited',
        change: (tree) => {
          writeFileSync(path.join(tree.path, 'README.md'), 'work added after the crash\n');
        },
      },
      {
        name: 'a file added',
        change: (tree) => {
          writeFileSync(path.join(tree.path, 'notes.txt'), 'work added after the crash\n');
        },
      },
      {
        name: 'a file ignored by the repository added',
        before: () => {
          writeFileSync(path.join(app, '.gitignore'), '*.log\n');
          git(app, env, 'add', '.gitignore');
          commit(app, env, 'ignore logs');
        },
        change: (tree) => {
          writeFileSync(path.join(tree.path, 'kept.log'), 'work added after the crash\n');
        },
      },
      {
        name: 'a file removed',
        change: (tree) => {
          rmSync(path.join(tree.path, 'README.md'));
        },
      },
      {
        name: 'a same-length edit, its time set back, where the repository trusts neither ctime nor full stat',
        before: () => {
          git(app, env, 'config', 'core.trustctime', 'false');
          git(app, env, 'config', 'core.checkStat', 'minimal');
        },
        change: (tree) => {
          const file = path.join(tree.path, 'README.md');
          const { atime, mtime } = statSync(file);
          writeFileSync(file, 'HELLO\n');
          utimesSync(file, atime, mtime);
        },
      },
      {
        name: 'a submodule’s folder filled in',
        before: () => {
          const sub = makeRepository(path.join(root, 'sub'), env, { 'lib.txt': 'lib\n' });
          git(app, env, 'update-index', '--add', '--cacheinfo', `160000,${sub},vendor/sub`);
          commit(app, env, 'a submodule');
        },
        change: (tree) => {
          writeFileSync(path.join(tree.path, 'vendor', 'sub', 'work.txt'), 'work\n');
        },
      },
      {
        name: 'its files written part way, before Git wrote its index',
        change: (tree, registration) => {
          rmSync(path.join(registration, 'index'));
          rmSync(path.join(tree.path, 'README.md'));
          writeFileSync(path.join(tree.path, 'src', 'main.ts'), 'exp');
        },
      },
      {
        name: 'its index still being written',
        change: (_tree, registration) => {
          writeFileSync(path.join(registration, 'index.lock'), '');
        },
      },
    ];

    it.each(changes)(
      'holds for you a population it didn’t mark that may have changed since, never populating over it: $name',
      async ({ before, change }) => {
        before?.();
        const dying = new Crashing(at('read-tree'), true);
        const first = provisioner({ git: dying });
        const repository = await repositoryOf(first);
        void first.provision({ canvas: CANVAS, repository, owner: OWNER });
        await dying.crashed.promise;
        const [open] = workspaces.openJobs();
        expect(open?.phase).toBe('registered');
        const tree = kept(open?.workspace ?? '');
        change(tree, path.join(app, '.git', 'worktrees', tree.id));
        const held = contents(tree.path);

        const git2 = new Recording(runnerDeps());
        const restarted = provisioner({ git: git2 });
        await restarted.reconcile();
        expect(contents(tree.path)).toEqual(held);
        expect(kept(tree.id)).toMatchObject({
          state: 'error',
          errorCode: 'interrupted-population',
        });
        expect(await restarted.checkout(tree.id)).toMatchObject({ state: 'held', reason: 'error' });
        // Your retry looks again, and holds it again.
        expect(await restarted.retry(tree.id)).toMatchObject({
          state: 'error',
          errorCode: 'interrupted-population',
        });
        expect(contents(tree.path)).toEqual(held);
        expect(git2.count('read-tree')).toBe(0);
        expect(workspaces.openJobs()).toEqual([]);
      },
    );

    it('populates a checkout found registered but never written, refusing to write over a file put there', async () => {
      // Registered, then the core stopped before population: nothing written there yet.
      const dying = new Crashing(at('read-tree'), false);
      const first = provisioner({ git: dying });
      const repository = await repositoryOf(first);
      void first.provision({ canvas: CANVAS, repository, owner: OWNER });
      await dying.crashed.promise;
      const tree = kept(workspaces.openJobs()[0]?.workspace ?? '');
      expect(readdirSync(tree.path)).toEqual(['.git']);
      // A file put there as Git starts writing: Git is told not to write over it.
      class Racing extends GitRunner {
        override run(call: GitCall): Promise<GitOutput> {
          if (call.args[0] === 'read-tree') {
            writeFileSync(path.join(tree.path, 'README.md'), 'put there meanwhile\n');
          }
          return super.run(call);
        }
      }
      await provisioner({ git: new Racing(runnerDeps()) }).reconcile();
      expect(readFileSync(path.join(tree.path, 'README.md'), 'utf8')).toBe('put there meanwhile\n');
      expect(kept(tree.id)).toMatchObject({ state: 'error', errorCode: 'git-failed' });
    });

    it.each(cases)(
      'finishes a workspace the core stopped making $name, from what Git has',
      async ({ when, after, phase, damage, redone }) => {
        const dying = new Crashing(when, after);
        const first = provisioner({ git: dying });
        const repository = await repositoryOf(first);
        void first.provision({ canvas: CANVAS, repository, owner: OWNER });
        await dying.crashed.promise;
        const [open] = workspaces.openJobs();
        expect(open?.phase).toBe(phase);
        const tree = kept(open?.workspace ?? '');
        expect(tree.state).toBe('creating');
        damage?.(tree);

        // The core starts again: a new provisioner over what is on disk.
        const git2 = new Recording(runnerDeps());
        const restarted = provisioner({ git: git2 });
        await restarted.reconcile();
        const made = kept(tree.id);
        expectMade(made);
        expect(workspaces.openJobs()).toEqual([]);
        expect(workspaces.jobsOf(tree.id)).toMatchObject([{ outcome: 'done' }]);
        for (const { command, times } of redone) expect(git2.count(...command)).toBe(times);
        // Starting it again reuses it.
        expect((await restarted.provision({ canvas: CANVAS, repository, owner: OWNER })).id).toBe(
          tree.id,
        );
      },
    );

    it('notices a checkout removed while the core was stopped, and one removed while it runs', async () => {
      const p = provisioner();
      const repository = await repositoryOf(p);
      const one = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
      const two = await p.provision({ canvas: CANVAS, repository, owner: 'group/team' });
      rmSync(one.path, { recursive: true, force: true });
      const changed = vi.fn();
      const restarted = provisioner({ changed });
      await restarted.reconcile();
      expect(workspaces.worktree(one.id)).toMatchObject({
        state: 'missing',
        errorCode: 'checkout-missing',
      });
      expect(workspaces.worktree(two.id)?.state).toBe('setup');
      expect(changed).toHaveBeenCalledWith(CANVAS);
      expect(await restarted.checkout(one.id)).toMatchObject({ state: 'held', reason: 'missing' });
      // Removed while it runs: noticed as its path is asked for, never handed out.
      const aside = path.join(root, 'aside');
      renameSync(two.path, aside);
      expect(await restarted.checkout(two.id)).toMatchObject({ state: 'held', reason: 'missing' });
      expect(workspaces.worktree(two.id)).toMatchObject({
        state: 'missing',
        errorCode: 'checkout-missing',
      });
      // Put back as it was, a retry finds it, at a new generation: what ran in it before is stale.
      renameSync(aside, two.path);
      const generation = workspaces.worktree(two.id)?.generation ?? 0;
      const back = await restarted.retry(two.id);
      expect(back.state).toBe('setup');
      expect(back.generation).toBeGreaterThan(generation);
      expect((await restarted.checkout(two.id)).state).toBe('setup');
      // One gone for good stays missing: a retry never makes another over its branch.
      expect((await restarted.retry(one.id)).state).toBe('missing');
      expect(branches()).toHaveLength(2);
    });
  });

  it('keeps its checkouts, and their ownership, through a git clean -fdx of the picked checkout', async () => {
    const p = provisioner();
    const repository = await repositoryOf(p);
    const tree = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
    writeFileSync(path.join(app, 'build.log'), 'ignored\n');
    git(app, env, 'clean', '-fdx');
    expect(existsSync(path.join(app, 'build.log'))).toBe(false);
    expect(await p.checkout(tree.id)).toMatchObject({ state: 'setup' });
    expectMade(kept(tree.id));
  });

  it('never trusts a checkout whose .git was replaced', async () => {
    const p = provisioner();
    const repository = await repositoryOf(p);
    const tree = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
    writeFileSync(path.join(tree.path, '.git'), `gitdir: ${path.join(app, '.git')}\n`);
    expect(await p.checkout(tree.id)).toMatchObject({ state: 'held', reason: 'error' });
    expect(workspaces.worktree(tree.id)).toMatchObject({
      state: 'error',
      errorCode: 'checkout-changed',
    });
  });

  describe('a hostile repository', () => {
    it('runs none of its hooks, fsmonitor, filters, LFS, diff drivers or conditional includes, nor the environment’s', async () => {
      const sentinel = path.join(root, 'ran');
      const program = sentinelProgram(root, sentinel);
      const hostile = path.join(root, 'hostile');
      const oid = makeRepository(hostile, env, {
        '.gitattributes': '*.txt filter=evil diff=evil\n*.md filter=late\n*.bin filter=lfs\n',
        'a.txt': 'plain text\n',
        'notes.md': 'notes\n',
        'blob.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n',
      });
      const hook = `#!/bin/sh\n'${program}' hook "$@"\n`;
      const evilHooks = path.join(root, 'evil-hooks');
      mkdirSync(evilHooks);
      for (const name of ['post-checkout', 'reference-transaction', 'post-index-change']) {
        writeFileSync(path.join(hostile, '.git', 'hooks', name), hook, { mode: 0o755 });
        writeFileSync(path.join(evilHooks, name), hook, { mode: 0o755 });
      }
      const late = path.join(root, 'late.config');
      writeFileSync(late, `[filter "late"]\n\tsmudge = '${program}' late\n\trequired = true\n`);
      for (const [key, value] of [
        ['core.hooksPath', evilHooks],
        ['core.fsmonitor', program],
        ['filter.evil.clean', `${program} clean`],
        ['filter.evil.smudge', `${program} smudge`],
        ['filter.evil.required', 'true'],
        ['filter.lfs.process', `${program} lfs`],
        ['filter.lfs.required', 'true'],
        ['diff.evil.textconv', program],
        ['diff.external', program],
        ['includeIf.onbranch:corrallm/**.path', late],
      ] as const) {
        git(hostile, env, 'config', key, value);
      }
      const elsewhere = path.join(root, 'elsewhere');
      makeRepository(elsewhere, env);
      const hostileEnv = {
        ...env,
        GIT_DIR: path.join(elsewhere, '.git'),
        GIT_WORK_TREE: elsewhere,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: evilHooks,
      };
      const p = provisioner({
        git: new GitRunner({ ...runnerDeps(), environment: () => Promise.resolve(hostileEnv) }),
      });
      const found = await p.repository(hostile);
      if (found.kind !== 'repository') throw new Error(JSON.stringify(found));
      const tree = await p.provision({ canvas: CANVAS, repository: found.record, owner: OWNER });
      expect(tree.state).toBe('setup');
      expect(await p.checkout(tree.id)).toMatchObject({ state: 'setup' });
      // Checked out as committed: no filter ran on the way in, LFS's pointer kept as it is.
      expect(readFileSync(path.join(tree.path, 'a.txt'), 'utf8')).toBe('plain text\n');
      expect(readFileSync(path.join(tree.path, 'notes.md'), 'utf8')).toBe('notes\n');
      expect(readFileSync(path.join(tree.path, 'blob.bin'), 'utf8')).toMatch(/^version https/);
      expect(git(tree.path, env, 'rev-parse', 'HEAD').trim()).toBe(oid);
      expect(ran(sentinel)).toEqual([]);
      // Nothing of the environment's repository changed.
      expect(
        git(elsewhere, env, 'worktree', 'list', '--porcelain').match(/^worktree /gm),
      ).toHaveLength(1);

      // The control: plain Git, nothing stopping it, runs them.
      try {
        git(
          hostile,
          env,
          'worktree',
          'add',
          '-q',
          '-b',
          'corrallm/control',
          path.join(root, 'control'),
        );
      } catch {
        // A required driver that isn't a real filter fails the checkout, after it ran.
      }
      expect(ran(sentinel).length).toBeGreaterThan(0);
    });

    it('fails closed on a conditional include redirecting the new checkout', async () => {
      const elsewhere = path.join(root, 'elsewhere');
      mkdirSync(elsewhere);
      const late = path.join(root, 'late.config');
      writeFileSync(late, `[core]\n\tworktree = ${elsewhere}\n`);
      git(app, env, 'config', 'includeIf.onbranch:corrallm/**.path', late);
      const p = provisioner();
      const repository = await repositoryOf(p);
      const tree = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
      expect(tree).toMatchObject({ state: 'error', errorCode: 'config' });
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readdirSync(tree.path)).toEqual(['.git']);
      expect(await p.checkout(tree.id)).toMatchObject({ state: 'held', reason: 'error' });
    });

    it('writes nothing through a symlinked owned root', async () => {
      const outside = path.join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, path.join(app, '.corral'));
      const p = provisioner();
      const repository = await repositoryOf(p);
      const tree = await p.provision({ canvas: CANVAS, repository, owner: OWNER });
      expect(tree).toMatchObject({ state: 'error', errorCode: 'owned-root-symlinked' });
      expect(readdirSync(outside)).toEqual([]);
      expect(branches()).toEqual([]);
      expect(registered()).toEqual([app]);
    });

    it('never takes over a folder or branch at the workspace’s place that it didn’t make', async () => {
      const p = provisioner();
      const repository = await repositoryOf(p);
      const intend = (owner: `agent/${string}`) =>
        workspaces.write((w) =>
          p.intend(w, {
            canvas: CANVAS,
            repository,
            owner,
            base: { checkout: app, ref: 'refs/heads/main', oid: base },
          }),
        );
      // A folder already there, with someone's work in it.
      const one = await intend('agent/one');
      // The owned root is the core's; the folder in it at the workspace's place isn't.
      ensureOwnedRoot(repository);
      mkdirSync(one.worktree.path);
      writeFileSync(path.join(one.worktree.path, 'work.txt'), 'someone’s\n');
      expect(await p.run(one.job?.id ?? '')).toMatchObject({
        state: 'error',
        errorCode: 'unregistered-checkout',
      });
      expect(readFileSync(path.join(one.worktree.path, 'work.txt'), 'utf8')).toBe('someone’s\n');
      // Its branch already there, at another commit.
      writeFileSync(path.join(app, 'more.txt'), 'more\n');
      git(app, env, 'add', 'more.txt');
      commit(app, env, 'more');
      const other = git(app, env, 'rev-parse', 'HEAD').trim();
      const two = await intend('agent/two');
      git(app, env, 'update-ref', two.worktree.branchRef, other);
      expect(await p.run(two.job?.id ?? '')).toMatchObject({
        state: 'error',
        errorCode: 'branch-moved',
      });
      expect(git(app, env, 'rev-parse', two.worktree.branchRef).trim()).toBe(other);
      expect(existsSync(two.worktree.path)).toBe(false);
      // Once it is gone, a retry (twice at once: one job) makes it from its recorded base.
      git(app, env, 'update-ref', '-d', two.worktree.branchRef);
      const [retried, again] = await Promise.all([
        p.retry(two.worktree.id),
        p.retry(two.worktree.id),
      ]);
      expect(retried.state).toBe('setup');
      expect(again.id).toBe(retried.id);
      expect(
        workspaces
          .jobsOf(two.worktree.id)
          .map(({ outcome }) => outcome)
          .sort(),
      ).toEqual(['done', 'failed']);
      expect(git(app, env, 'rev-parse', two.worktree.branchRef).trim()).toBe(base);
    });
  });

  it('records a retry before running it: started, it answers once its new attempt is on disk', async () => {
    /** A runner holding every `worktree add` until it is let go. */
    class Held extends GitRunner {
      readonly go = Promise.withResolvers<undefined>();
      override async run(call: GitCall): Promise<GitOutput> {
        if (call.args[0] === 'worktree' && call.args[1] === 'add') await this.go.promise;
        return super.run(call);
      }
    }
    const runner = new Held(runnerDeps());
    const p = provisioner({ git: runner });
    const repository = await repositoryOf(p);
    const { worktree, job } = await workspaces.write((w) =>
      p.intend(w, {
        canvas: CANVAS,
        repository,
        owner: OWNER,
        base: { checkout: app, ref: 'refs/heads/main', oid: base },
      }),
    );
    // Its branch is somewhere else: making it fails, touching nothing.
    writeFileSync(path.join(app, 'more.txt'), 'more\n');
    git(app, env, 'add', 'more.txt');
    commit(app, env, 'more');
    git(app, env, 'update-ref', worktree.branchRef, git(app, env, 'rev-parse', 'HEAD').trim());
    expect(await p.run(job?.id ?? '')).toMatchObject({ state: 'error', errorCode: 'branch-moved' });
    git(app, env, 'update-ref', '-d', worktree.branchRef);
    const changed = vi.fn();
    const q = provisioner({ git: runner, changed });
    const [first, second] = await Promise.all([
      q.startRetry(worktree.id),
      q.startRetry(worktree.id),
    ]);
    // Recorded, not yet made: a new attempt of the same intent, its Git work held meanwhile.
    expect(first.tree).toMatchObject({ id: worktree.id, state: 'creating' });
    expect(workspaces.worktree(worktree.id)?.state).toBe('creating');
    expect(workspaces.openJobs()).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith(CANVAS);
    expect(second.done).toBe(first.done);
    expect(existsSync(worktree.path)).toBe(false);
    runner.go.resolve(undefined);
    expect(await first.done).toMatchObject({ id: worktree.id, state: 'setup' });
    // Nothing to retry in one ready for setup: as it is, at once.
    const again = await q.startRetry(worktree.id);
    expect(again.tree.state).toBe('setup');
    expect(await again.done).toMatchObject({ state: 'setup' });
  });

  it('refuses work past the queue’s bound before recording any', async () => {
    const p = provisioner({ queue: new ProvisioningQueue({ capacity: 0 }) });
    const repository = await repositoryOf(p);
    await expect(p.provision({ canvas: CANVAS, repository, owner: OWNER })).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(p.provision({ canvas: CANVAS, repository, owner: OWNER })).rejects.toBeInstanceOf(
      ProvisionError,
    );
    expect(workspaces.worktreesOf(CANVAS)).toEqual([]);
  });

  it('holds a repository that changed since it was found', async () => {
    const p = provisioner();
    const repository = await repositoryOf(p);
    renameSync(path.join(app, '.git'), path.join(root, 'old-git'));
    git(app, env, 'init', '-q', '-b', 'main');
    git(app, env, 'add', '-A');
    commit(app, env, 'again');
    await expect(p.provision({ canvas: CANVAS, repository, owner: OWNER })).rejects.toMatchObject({
      code: 'repository-changed',
    });
    expect(workspaces.worktreesOf(CANVAS)).toEqual([]);
  });
});
