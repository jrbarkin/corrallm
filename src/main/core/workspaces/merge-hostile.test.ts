import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitError, GitRunner } from './git';
import type { GitIdentity, GitOutput } from './git';
import { makeTemporaryIndex } from './merge-index';
import type { RepositoryTemplate } from './test-git';
import {
  caseInsensitive,
  commit,
  differing,
  git,
  gitEnvironment,
  gitInits,
  hooksInto,
  listing,
  makeRepository,
  ran,
  repositoryTemplate,
  scratch,
  sentinelProgram,
} from './test-git';

/*
 * B9b Design §9.1's hostile repositories, made permanent: the Git facts the merge rests on (F1 to
 * F12), each through the runner and its merge profile, in throwaway repositories whose every
 * program a repository can make Git run (hooks, filters, merge drivers, signing and diff
 * programs, editors, Git LFS) only records that it ran. Beside each, a control without the
 * runner's options shows that sentinel would have fired. Real Git: on macOS the system's, on
 * Linux CI Debian's 2.39.5. Where an older Git lacks a feature (a reftable or SHA-256 repository),
 * the test probes for it and says it skipped; where Git versions differ in how they fail closed
 * (a merge driver blanked), either failure passes, never a merged result.
 */

// Real Git, a repository or two each: slower under load, or on Linux CI's emulated x64. A
// describe's template repository is made in its beforeAll, under the same bound.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REFTABLE = gitInits('--ref-format=reftable');
const SHA256 = gitInits('--object-format=sha256');
const CASE_INSENSITIVE = caseInsensitive();

const CORRALLM: GitIdentity = { name: 'corrallm', email: 'noreply@corrallm.invalid' };
const YOU: GitIdentity = { name: 'Test', email: 'test@example.invalid' };

let root: string;
let remove: () => void;
let env: Record<string, string>;
let sentinel: string;
let program: string;
let runner: GitRunner;

/**
 * A runner as the merge service's: git's environment as `environment` says at each call (a test
 * that changes `env` changes what its runner's git sees), and an empty hooks folder in `at`.
 */
function runnerIn(at: string, environment: () => Record<string, string>): GitRunner {
  return new GitRunner({
    environment: () => Promise.resolve(environment()),
    hooks: path.join(at, 'hooks'),
  });
}

beforeEach(() => {
  ({ root, remove } = scratch('corrallm-merge-'));
  env = gitEnvironment(path.join(root, 'home'));
  sentinel = path.join(root, 'ran');
  program = sentinelProgram(root, sentinel);
  runner = runnerIn(root, () => env);
});
afterEach(() => {
  remove();
});

/** What ran since it was last asked, then forgets it. */
function heard(): string[] {
  const found = ran(sentinel);
  writeFileSync(sentinel, '');
  return found;
}

/** Writes `files` in `at` (null deletes one), then commits them all (with git's `e`). */
function change(
  at: string,
  files: Record<string, string | null>,
  message: string,
  e: Record<string, string> = env,
): string {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(at, file);
    if (text === null) rmSync(full, { recursive: true, force: true });
    else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  git(at, e, 'add', '-A', '--force');
  commit(at, e, message);
  return git(at, e, 'rev-parse', 'HEAD').trim();
}

/**
 * A repository at `at` whose agent branch and main moved on from a base: main checked out at its
 * tip. Its commits.
 */
function diverged(
  at: string,
  {
    base = { 'a.txt': 'one\ntwo\nthree\n' },
    agent = { 'a.txt': 'one\ntwo\nthree\nagent\n', 'b.txt': 'b\n' },
    main = { 'c.txt': 'c\n' },
  }: {
    base?: Record<string, string>;
    agent?: Record<string, string | null>;
    main?: Record<string, string | null>;
  } = {},
  options: string[] = [],
  e: Record<string, string> = env,
): { base: string; agent: string; main: string } {
  mkdirSync(at, { recursive: true });
  git(at, e, 'init', '-q', '-b', 'main', ...options);
  const first = change(at, base, 'base', e);
  git(at, e, 'switch', '-q', '-c', 'agent');
  const theirs = change(at, agent, 'agent', e);
  git(at, e, 'switch', '-q', 'main');
  const ours = change(at, main, 'main', e);
  return { base: first, agent: theirs, main: ours };
}

/** Git's merge of `theirs` into `ours`, computed in `cwd` as the merge service computes it. */
async function mergeTree(
  cwd: string,
  ours: string,
  theirs: string,
  { profile = true, filters = true }: { profile?: boolean; filters?: boolean } = {},
  through: GitRunner = runner,
): Promise<{ code: number; tree: string; conflicted: string[] }> {
  const { drivers, mergeDrivers } = await through.inspect(cwd);
  const { code, stdout } = await through.run({
    cwd,
    args: ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, theirs],
    ...(filters ? { drivers } : {}),
    ...(profile ? { merge: { drivers: mergeDrivers } } : {}),
    answers: [1],
  });
  const [tree = '', ...conflicted] = stdout.split('\0').filter(Boolean);
  return { code, tree, conflicted };
}

/** The merge commit of `theirs` into `ours`, prepared as the merge service prepares it: M. */
async function prepare(
  cwd: string,
  ours: string,
  theirs: string,
  through: GitRunner = runner,
): Promise<string> {
  const { code, tree } = await mergeTree(cwd, ours, theirs, {}, through);
  expect(code).toBe(0);
  return through.commitTree({
    cwd,
    tree,
    parents: [ours, theirs],
    message: "Merge branch 'agent' into main\n\nCorrallm-Requested-By: you\n",
    author: YOU,
    committer: YOU,
    merge: { drivers: (await through.inspect(cwd)).mergeDrivers },
  });
}

/** The install of M in `cwd`, as the merge service installs it. */
async function install(cwd: string, m: string): Promise<GitOutput> {
  const { drivers, mergeDrivers } = await runner.inspect(cwd);
  return runner.install({ cwd, commit: m, drivers, merge: { drivers: mergeDrivers } });
}

/** What a promise failed with: its GitError, or undefined if it answered. */
async function failed(promise: Promise<unknown>): Promise<GitError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof GitError) return error;
    throw error;
  }
}

/** Everything in a repository's checkout and Git directory but its objects. */
const notObjects = (relative: string) => relative === path.join('.git', 'objects');

/** A merge driver that records it ran and says it merged cleanly: Git would take what it left. */
function driverProgram(): string {
  const file = path.join(root, 'driver.sh');
  writeFileSync(file, `#!/bin/sh\necho "merge-driver $*" >> '${sentinel}'\nexit 0\n`, {
    mode: 0o755,
  });
  return file;
}

describe.skipIf(process.platform === 'win32')('merge-tree under the merge profile', () => {
  it('computes a merge and its conflicts away from any checkout, writing only objects (F1)', async () => {
    const at = path.join(root, 'r');
    const { main, agent } = diverged(at);
    const before = listing(at, notObjects);
    const clean = await mergeTree(at, main, agent);
    expect(clean.code).toBe(0);
    expect(git(at, env, 'ls-tree', '-r', '--name-only', clean.tree).split('\n')).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
      '',
    ]);
    // No index, file or ref written, no MERGE_HEAD or AUTO_MERGE: only objects.
    expect(differing(before, listing(at, notObjects))).toEqual([]);
    git(at, env, 'switch', '-q', '-c', 'theirs', agent);
    const conflicting = change(at, { 'a.txt': 'one\nTWO-agent\nthree\n' }, 'theirs');
    git(at, env, 'switch', '-q', 'main');
    const ours = change(at, { 'a.txt': 'one\nTWO-main\nthree\n' }, 'ours');
    const settled = listing(at, notObjects);
    const conflict = await mergeTree(at, ours, conflicting);
    expect(conflict.code).toBe(1);
    expect(conflict.conflicted).toEqual(['a.txt']);
    // A conflict leaves nothing in the checkout either: no markers, no merge state.
    expect(differing(settled, listing(at, notObjects))).toEqual([]);
    // Unrelated histories refuse.
    const empty = git(at, env, 'mktree').trim();
    const lonely = git(
      at,
      env,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      'commit-tree',
      '-m',
      'lonely',
      empty,
    ).trim();
    expect((await failed(mergeTree(at, ours, lonely)))?.exitCode).toBe(128);
    // A source that fast-forwards gives exactly its tree.
    git(at, env, 'switch', '-q', '-c', 'ahead', ours);
    const ahead = change(at, { 'd.txt': 'd\n' }, 'ahead');
    git(at, env, 'switch', '-q', 'main');
    expect((await mergeTree(at, ours, ahead)).tree).toBe(
      git(at, env, 'rev-parse', `${ahead}^{tree}`).trim(),
    );
  });

  describe('runs no custom merge driver, and a path that needs one fails closed (F2, F3)', () => {
    let template: RepositoryTemplate<{ main: string; agent: string }>;
    let at: string;
    let ours: string;
    let theirs: string;

    // Both sides change a.txt's same line, made once; each test's copy names its own driver.
    beforeAll(async () => {
      template = await repositoryTemplate((made, e) =>
        diverged(
          made,
          {
            agent: { 'a.txt': 'one\nTWO-agent\nthree\n' },
            main: { 'a.txt': 'one\nTWO-main\nthree\n' },
          },
          [],
          e,
        ),
      );
    });
    afterAll(() => {
      template.remove();
    });
    beforeEach(() => {
      at = path.join(root, 'r');
      ({ main: ours, agent: theirs } = template.copy(at, env));
      git(at, env, 'config', 'merge.sent.driver', `${driverProgram()} %O %A %B`);
    });

    /** That the merge didn't land: a conflict (Git 2.50) or a stop (Git 2.39), never a tree. */
    async function failsClosed(): Promise<void> {
      const outcome = await mergeTree(at, ours, theirs).catch((error: unknown) => error);
      if (outcome instanceof GitError) expect(outcome.exitCode).toBe(128);
      else expect(outcome).toMatchObject({ code: 1, conflicted: ['a.txt'] });
      expect(heard()).toEqual([]);
    }

    it('named by an attribute committed on both sides', async () => {
      git(at, env, 'switch', '-q', 'agent');
      theirs = change(at, { '.gitattributes': 'a.txt merge=sent\n' }, 'attributes');
      git(at, env, 'switch', '-q', 'main');
      ours = change(at, { '.gitattributes': 'a.txt merge=sent\n' }, 'attributes');
      // The control: without the profile, Git runs the driver and takes its "clean" merge.
      expect((await mergeTree(at, ours, theirs, { profile: false })).code).toBe(0);
      expect(heard().length).toBeGreaterThan(0);
      await failsClosed();
    });

    it('named by an attribute only in your checkout, uncommitted: the checkout’s attributes apply', async () => {
      writeFileSync(path.join(at, '.gitattributes'), 'a.txt merge=sent\n');
      expect((await mergeTree(at, ours, theirs, { profile: false })).code).toBe(0);
      expect(heard().length).toBeGreaterThan(0);
      await failsClosed();
    });

    it('named by merge.default, with no attribute anywhere', async () => {
      git(at, env, 'config', 'merge.default', 'sent');
      expect((await mergeTree(at, ours, theirs, { profile: false })).code).toBe(0);
      expect(heard().length).toBeGreaterThan(0);
      await failsClosed();
    });

    it('not named where it runs: an attribute only in the incoming commit is not the checkout’s', async () => {
      git(at, env, 'switch', '-q', 'agent');
      theirs = change(at, { '.gitattributes': 'a.txt merge=sent\n' }, 'attributes');
      git(at, env, 'switch', '-q', 'main');
      expect(await mergeTree(at, ours, theirs, { profile: false })).toMatchObject({ code: 1 });
      expect(heard()).toEqual([]);
    });
  });

  it('runs no filter while merging, whatever merge.renormalize the repository sets (F4)', async () => {
    const at = path.join(root, 'r');
    // Both sides change a.txt, apart: a content merge, which is where renormalizing filters it.
    const { main, agent } = diverged(at, {
      base: { 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' },
      agent: {
        '.gitattributes': '*.txt filter=sentf\n',
        'a.txt': 'one\ntwo\nthree\nfour\nfive\nagent\n',
      },
      main: {
        '.gitattributes': '*.txt filter=sentf\n',
        'a.txt': 'main\none\ntwo\nthree\nfour\nfive\n',
      },
    });
    git(at, env, 'config', 'filter.sentf.clean', `${program} clean`);
    git(at, env, 'config', 'filter.sentf.smudge', `${program} smudge`);
    git(at, env, 'config', 'merge.renormalize', 'true');
    heard();
    // The control: renormalizing runs the filters, unless they are blanked.
    await mergeTree(at, main, agent, { profile: false, filters: false });
    expect(heard().length).toBeGreaterThan(0);
    await mergeTree(at, main, agent);
    expect(heard()).toEqual([]);
    // The profile's renormalize=false holds even for a filter it wasn't told to blank.
    await mergeTree(at, main, agent, { filters: false });
    expect(heard()).toEqual([]);
  });

  it('merges a SHA-256 repository the same (C11)', async (context) => {
    if (!SHA256) {
      context.skip('this Git cannot make a SHA-256 repository');
      return;
    }
    const at = path.join(root, 'r');
    const { main, agent } = diverged(at, {}, ['--object-format=sha256']);
    const m = await prepare(at, main, agent);
    expect(m).toMatch(/^[0-9a-f]{64}$/);
    await install(at, m);
    expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(m);
  });

  it('merges a repository keeping its refs in reftable the same (C11)', async (context) => {
    if (!REFTABLE) {
      context.skip('this Git cannot make a reftable repository, which needs Git 2.45');
      return;
    }
    const at = path.join(root, 'r');
    const { main, agent } = diverged(at, {}, ['--ref-format=reftable']);
    const m = await prepare(at, main, agent);
    await install(at, m);
    expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(m);
    expect(git(at, env, 'rev-parse', 'ORIG_HEAD').trim()).toBe(main);
  });

  it('means the objects themselves: replace refs are ignored where it reads (C11)', async () => {
    const at = path.join(root, 'r');
    const { main, agent } = diverged(at);
    git(at, env, 'switch', '-q', '-c', 'decoy', main);
    const decoy = change(at, { 'decoy.txt': 'decoy\n' }, 'decoy');
    git(at, env, 'switch', '-q', 'main');
    git(at, env, 'replace', agent, decoy);
    // The control: Git otherwise reads the replacement wherever the agent's commit is named.
    expect(git(at, env, 'ls-tree', '--name-only', agent)).toContain('decoy.txt');
    const { tree } = await mergeTree(at, main, agent);
    const names = git(at, env, 'ls-tree', '-r', '--name-only', tree);
    expect(names).toContain('b.txt');
    expect(names).not.toContain('decoy.txt');
    const read = await runner.run({
      cwd: at,
      args: ['ls-tree', '--name-only', agent],
      noReplaceObjects: true,
    });
    expect(read.stdout).not.toContain('decoy.txt');
  });
});

describe.skipIf(process.platform === 'win32')('the install', () => {
  /**
   * A repository whose agent branch brings `gen.log`, ignored at the base, configured by `then`,
   * and M prepared there.
   */
  async function prepared(
    at: string,
    then: (at: string) => void = () => undefined,
  ): Promise<{ old: string; m: string }> {
    const { main, agent } = diverged(at, {
      base: { '.gitignore': '*.log\n', 'a.txt': 'base\n' },
      agent: { 'a.txt': 'base\nagent\n', 'gen.log': 'tracked\n' },
      main: { 'm.txt': 'main\n' },
    });
    then(at);
    return { old: main, m: await prepare(at, main, agent) };
  }

  /** Every program a repository can configure for a merge or checkout, each a sentinel. */
  function hostile(at: string): void {
    hooksInto(path.join(at, '.git', 'hooks'), program);
    const configured = path.join(root, `hooks-of-${path.basename(at)}`);
    hooksInto(configured, program);
    const settings: [string, string][] = [
      ['core.hooksPath', configured],
      ['gpg.program', program],
      ['merge.verifySignatures', 'true'],
      ['merge.autoStash', 'true'],
      ['merge.stat', 'true'],
      ['merge.ff', 'false'],
      ['diff.external', program],
      ['branch.main.mergeOptions', '--verify-signatures --autostash --stat --squash --no-ff'],
      ['commit.gpgSign', 'true'],
      ['core.editor', program],
      ['filter.sentf.smudge', `${program} smudge`],
      ['filter.sentf.clean', `${program} clean`],
      ['filter.sentf.process', `${program} process`],
      ['filter.sentf.required', 'true'],
    ];
    for (const [key, value] of settings) git(at, env, 'config', key, value);
    writeFileSync(path.join(at, '.git', 'info', 'attributes'), '*.txt filter=sentf\n');
  }

  it('prepares and installs running no program a hostile repository configures, and takes no option it sets (F7)', async () => {
    const at = path.join(root, 'r');
    const { m } = await prepared(at, (made) => {
      hostile(made);
      heard();
    });
    await install(at, m);
    expect(heard()).toEqual([]);
    expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(m);
    expect(git(at, env, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    // Not squashed (branch.main.mergeOptions), and written as Git keeps it (no smudge).
    expect(existsSync(path.join(at, '.git', 'SQUASH_MSG'))).toBe(false);
    expect(readFileSync(path.join(at, 'a.txt'), 'utf8')).toBe('base\nagent\n');
    const { drivers } = await runner.inspect(at);
    const status = await runner.run({
      cwd: at,
      args: ['--no-optional-locks', 'status', '--porcelain', '--ignored'],
      drivers,
    });
    expect(status.stdout).toBe('');
    expect(heard()).toEqual([]);

    // The control: the same repository, installed by plain Git, runs them.
    const twin = path.join(root, 'twin');
    const control = await prepared(twin, hostile);
    heard();
    try {
      git(twin, env, 'merge', '--ff-only', '--no-verify-signatures', '-q', control.m);
    } catch {
      // The sentinel speaks no filter protocol: Git may stop, having started it.
    }
    expect(heard().length).toBeGreaterThan(0);
  });

  it('runs none of Git LFS’s programs, as `git lfs install --local` configures them (F7, C9b)', async () => {
    // A stand-in git-lfs, found as Git finds the real one: on the PATH.
    const bin = path.join(root, 'lfs-bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'git-lfs'),
      `#!/bin/sh\necho "git-lfs $*" >> '${sentinel}'\ncat\n`,
      {
        mode: 0o755,
      },
    );
    env = { ...env, PATH: `${bin}:${env.PATH ?? ''}` };
    const lfs = (at: string) => {
      for (const [key, value] of [
        ['filter.lfs.clean', 'git-lfs clean -- %f'],
        ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
        ['filter.lfs.process', 'git-lfs filter-process'],
        ['filter.lfs.required', 'true'],
      ] as const) {
        git(at, env, 'config', key, value);
      }
      for (const hook of ['pre-push', 'post-checkout', 'post-commit', 'post-merge']) {
        writeFileSync(path.join(at, '.git', 'hooks', hook), `#!/bin/sh\ngit lfs ${hook} "$@"\n`, {
          mode: 0o755,
        });
      }
    };
    const attributes = { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' };
    const repository = (at: string) =>
      diverged(at, {
        base: { ...attributes, 'a.txt': 'base\n' },
        agent: { 'model.bin': 'version https://git-lfs.github.com/spec/v1\n' },
        main: { 'm.txt': 'main\n' },
      });
    const at = path.join(root, 'r');
    const { main, agent } = repository(at);
    lfs(at);
    heard();
    const m = await prepare(at, main, agent);
    await install(at, m);
    expect(heard()).toEqual([]);
    expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(m);

    const twin = path.join(root, 'twin');
    const control = repository(twin);
    lfs(twin);
    const mTwin = await prepare(twin, control.main, control.agent);
    heard();
    try {
      git(twin, env, 'merge', '--ff-only', '-q', mTwin);
    } catch {
      // The stand-in doesn't speak the filter protocol: it is enough that Git started it.
    }
    expect(heard().length).toBeGreaterThan(0);
  });

  describe('refuses an ignored or untracked file in the way, writing only ORIG_HEAD (F5, F6)', () => {
    let template: RepositoryTemplate<{ old: string; m: string }>;
    let at: string;
    let old: string;
    let m: string;
    const outside = () => path.join(root, 'outside');

    // The repository and its M, prepared once (by a runner of the template's own); each test
    // puts its obstacle in a copy of its own.
    beforeAll(async () => {
      template = await repositoryTemplate(async (made, e, folder) => {
        const commits = diverged(
          made,
          {
            base: {
              '.gitignore': 'build/\n*.log\n*.tmp\nout\ngone/cache/\n',
              'a.txt': 'base\n',
              'gone/t.txt': 'tracked\n',
            },
            agent: {
              'a.txt': 'base\nagent\n',
              'build/out.txt': 'tracked in build\n',
              'gen.log': 'tracked log\n',
              'out/x.txt': 'x\n',
              'case.tmp': 'lower\n',
              gone: null,
            },
            main: { 'm.txt': 'main\n' },
          },
          [],
          e,
        );
        // A tracked folder that becomes a file, in a second commit (a path can't be both at once).
        git(made, e, 'switch', '-q', 'agent');
        const agent = change(made, { gone: 'now a file\n' }, 'gone', e);
        git(made, e, 'switch', '-q', 'main');
        return {
          old: commits.main,
          m: await prepare(
            made,
            commits.main,
            agent,
            runnerIn(folder, () => e),
          ),
        };
      });
    });
    afterAll(() => {
      template.remove();
    });
    beforeEach(() => {
      at = path.join(root, 'r');
      mkdirSync(outside());
      ({ old, m } = template.copy(at, env));
    });

    /** That the install refused with `obstacle` in place, changing nothing but ORIG_HEAD. */
    async function refused(): Promise<void> {
      const before = listing(at, notObjects);
      const error = await failed(install(at, m));
      expect(error?.fault).toBe('failed');
      expect(
        differing(before, listing(at, notObjects)).filter(
          (changed) => changed !== path.join('.git', 'ORIG_HEAD'),
        ),
      ).toEqual([]);
      expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(old);
      expect(readdirSync(outside())).toEqual([]);
    }

    /** Each obstacle: put in the way, then (`then`) what else holds once the install refused. */
    const obstacles: {
      name: string;
      place: () => void | Promise<void>;
      then?: () => void | Promise<void>;
      /** Only where the filesystem doesn't tell names apart by case. */
      caseInsensitive?: true;
    }[] = [
      {
        name: 'an ignored file where the merge brings a tracked one',
        place: () => {
          writeFileSync(path.join(at, 'gen.log'), 'precious\n');
        },
        then: async () => {
          // The control: plumbing's two-tree read-tree writes over it.
          const plumbing = await runner.run({
            cwd: at,
            args: ['read-tree', '-m', '-u', '--no-recurse-submodules', old, m],
          });
          expect(plumbing.code).toBe(0);
          expect(readFileSync(path.join(at, 'gen.log'), 'utf8')).toBe('tracked log\n');
        },
      },
      {
        name: 'an ignored file where the merge brings a folder',
        place: () => {
          writeFileSync(path.join(at, 'out'), 'precious\n');
        },
      },
      {
        name: 'an ignored symlink where the merge brings a folder: nothing written through it',
        place: () => {
          symlinkSync(outside(), path.join(at, 'out'));
        },
        then: () => {
          expect(readlinkSync(path.join(at, 'out'))).toBe(outside());
        },
      },
      {
        name: 'an ignored file inside a tracked folder that becomes a file',
        place: () => {
          mkdirSync(path.join(at, 'gone', 'cache'), { recursive: true });
          writeFileSync(path.join(at, 'gone', 'cache', 'blob'), 'cached\n');
        },
      },
      {
        name: 'an ignored file whose name differs only in case, where the filesystem doesn’t tell them apart',
        caseInsensitive: true,
        place: () => {
          writeFileSync(path.join(at, 'CASE.tmp'), 'upper\n');
        },
      },
      {
        name: 'an untracked file where the merge brings a tracked one',
        place: async () => {
          writeFileSync(path.join(at, '.git', 'info', 'exclude'), '');
          rmSync(path.join(at, '.gitignore'));
          git(at, env, 'add', '-A');
          commit(at, env, 'no ignores');
          old = git(at, env, 'rev-parse', 'HEAD').trim();
          m = await prepare(at, old, git(at, env, 'rev-parse', 'agent').trim());
          writeFileSync(path.join(at, 'gen.log'), 'precious\n');
        },
      },
    ];

    it.for(obstacles)('$name', async ({ place, then, caseInsensitive }, context) => {
      if (caseInsensitive && !CASE_INSENSITIVE) {
        context.skip('this filesystem tells names apart by case');
        return;
      }
      await place();
      await refused();
      await then?.();
    });

    it('but brings a tracked file into an ignored folder, keeping the folder’s other files', async () => {
      mkdirSync(path.join(at, 'build'));
      writeFileSync(path.join(at, 'build', 'keep.o'), 'object\n');
      await install(at, m);
      expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(m);
      expect(readFileSync(path.join(at, 'build', 'keep.o'), 'utf8')).toBe('object\n');
      expect(readFileSync(path.join(at, 'build', 'out.txt'), 'utf8')).toBe('tracked in build\n');
    });
  });

  it('fails closed while another git holds the index, and moves no ref but from what it expects (F9)', async () => {
    const at = path.join(root, 'r');
    const { old, m } = await prepared(at);
    writeFileSync(path.join(at, '.git', 'index.lock'), '');
    const before = listing(at, notObjects);
    // Refused as an ignored file in the way is: having written ORIG_HEAD alone, which the merge
    // service puts back (§9.3's step 7), the lock left as it was.
    expect((await failed(install(at, m)))?.fault).toBe('failed');
    expect(differing(before, listing(at, notObjects))).toEqual([path.join('.git', 'ORIG_HEAD')]);
    expect(git(at, env, 'rev-parse', 'HEAD').trim()).toBe(old);
    rmSync(path.join(at, '.git', 'index.lock'));
    // A ref moved only from the value expected: a stale one fails, changing nothing.
    const stale = await failed(
      runner.run({ cwd: at, args: ['update-ref', 'refs/heads/main', m, m] }),
    );
    expect(stale?.fault).toBe('failed');
    expect(git(at, env, 'rev-parse', 'main').trim()).toBe(old);
  });
});

describe.skipIf(process.platform === 'win32')('commits and identities', () => {
  it('makes a commit running nothing: no hook, editor or signing program, whatever the repository asks (F10)', async () => {
    const at = path.join(root, 'r');
    makeRepository(at, env);
    hooksInto(path.join(at, '.git', 'hooks'), program);
    for (const [key, value] of [
      ['gpg.program', program],
      ['commit.gpgSign', 'true'],
      ['core.editor', program],
      ['author.name', 'Repository Author'],
      ['author.email', 'author@example.invalid'],
      ['committer.name', 'Repository Committer'],
      ['committer.email', 'committer@example.invalid'],
    ] as const) {
      git(at, env, 'config', key, value);
    }
    const tree = git(at, env, 'rev-parse', 'HEAD^{tree}').trim();
    const head = git(at, env, 'rev-parse', 'HEAD').trim();
    heard();
    const made = await runner.commitTree({
      cwd: at,
      tree,
      parents: [head],
      message: 'corrallm: commit uncommitted work before merging\n\nCorrallm-Requested-By: you\n',
      author: CORRALLM,
      committer: CORRALLM,
      merge: { drivers: [] },
    });
    expect(heard()).toEqual([]);
    const body = git(at, env, 'cat-file', 'commit', made);
    expect(body).not.toContain('gpgsig');
    expect(body).toMatch(/^author corrallm <noreply@corrallm\.invalid> /m);
    expect(body).toMatch(/^committer corrallm <noreply@corrallm\.invalid> /m);
    expect(body).toContain(
      '\n\ncorrallm: commit uncommitted work before merging\n\nCorrallm-Requested-By: you\n',
    );
    // The controls: Git runs the repository's signing program and hooks when asked to commit.
    try {
      git(at, env, 'commit-tree', '-S', '-p', head, '-m', 'signed', tree);
    } catch {
      // The sentinel signs nothing: Git fails, having run it.
    }
    expect(heard().length).toBeGreaterThan(0);
    try {
      git(at, env, 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'hooked');
    } catch {
      // Whatever its hooks made of it.
    }
    expect(heard().join('\n')).toContain('pre-commit');
  });

  it('reads your identity only as you configured it, never one Git would invent (F10)', async () => {
    const at = path.join(root, 'r');
    makeRepository(at, env);
    env = { ...env, EMAIL: 'invented@example.invalid' };
    const ident = (name: string, config: string[]) =>
      runner.run({ cwd: at, args: ['var', name], config });
    // The control: without useConfigOnly, Git takes an email you never configured from the
    // environment (or makes one of your login and host).
    expect((await ident('GIT_COMMITTER_IDENT', ['user.name=Ada'])).stdout).toContain(
      'Ada <invented@example.invalid>',
    );
    for (const name of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      for (const config of [[], ['user.name=Ada']]) {
        expect((await failed(ident(name, [...config, 'user.useConfigOnly=true'])))?.fault).toBe(
          'failed',
        );
      }
    }
    git(at, env, 'config', 'user.name', 'Ada Lovelace');
    git(at, env, 'config', 'user.email', 'ada@example.invalid');
    for (const name of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      expect((await ident(name, ['user.useConfigOnly=true'])).stdout).toMatch(
        /^Ada Lovelace <ada@example\.invalid> \d+ [+-]\d{4}\n$/,
      );
    }
  });
});

describe.skipIf(process.platform === 'win32')('the temporary index', () => {
  /** Git's id of a blob holding `content` (SHA-1): what `add` stores for it. */
  const blobOf = (content: string) =>
    createHash('sha1')
      .update(`blob ${String(Buffer.byteLength(content))}\0${content}`)
      .digest('hex');

  it('commits an agent’s work without touching its own index, and runs no filter doing it (F11)', async () => {
    const at = path.join(root, 'r');
    makeRepository(at, env, {
      '.gitignore': '.env\n*.log\n',
      'a.txt': 'base\n',
      's.txt': 's\n',
      'del.txt': 'd\n',
    });
    const tree = path.join(root, 'agent-tree');
    git(at, env, 'worktree', 'add', '-q', '-b', 'agent', tree);
    const tip = git(tree, env, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(tree, 'a.txt'), 'base\nstaged\n');
    git(tree, env, 'add', 'a.txt');
    writeFileSync(path.join(tree, 'a.txt'), 'base\nstaged\nunstaged\n');
    writeFileSync(path.join(tree, 's.txt'), 's\nonly staged\n');
    git(tree, env, 'add', 's.txt');
    writeFileSync(path.join(tree, 's.txt'), 's\nin the worktree\n');
    rmSync(path.join(tree, 'del.txt'));
    writeFileSync(path.join(tree, 'new.txt'), 'new\n');
    writeFileSync(path.join(tree, '.env'), 'SECRET=1\n');
    writeFileSync(path.join(tree, 'x.log'), 'log\n');
    symlinkSync('a.txt', path.join(tree, 'link.txt'));
    const nested = path.join(tree, 'nested');
    makeRepository(nested, env, { n: 'n\n' });
    // Every text file goes through a filter, which only records that it ran.
    writeFileSync(path.join(at, '.git', 'info', 'attributes'), '*.txt filter=sentf\n');
    git(at, env, 'config', 'filter.sentf.clean', `${program} clean`);
    const gitDir = git(tree, env, 'rev-parse', '--absolute-git-dir').trim();
    const own = readFileSync(path.join(gitDir, 'index'));
    const objects = path.join(at, '.git', 'objects');
    const count = () => readdirSync(objects, { recursive: true }).length;
    heard();

    const { drivers } = await runner.inspect(tree);
    const index = makeTemporaryIndex(path.join(root, 'profile', 'workspaces', 'merge'), 'job-1');
    await runner.run({ cwd: tree, args: ['read-tree', tip], index, drivers });
    await runner.run({ cwd: tree, args: ['add', '-A'], index, drivers });
    const written = (
      await runner.run({ cwd: tree, args: ['write-tree'], index, drivers })
    ).stdout.trim();
    expect(readFileSync(path.join(gitDir, 'index')).equals(own)).toBe(true);
    expect(heard()).toEqual([]);
    const entries = Object.fromEntries(
      git(tree, env, 'ls-tree', '-r', written)
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [info = '', name = ''] = line.split('\t');
          const [mode, , oid] = info.split(' ');
          return [name, { mode, oid }];
        }),
    );
    // The files as they are (staged or not), deletions, new files and a link by its text; never
    // an ignored file; a nested repository as a gitlink, which the checkpoint refuses (C11).
    expect(Object.keys(entries).sort()).toEqual(
      ['.gitignore', 'a.txt', 'link.txt', 'nested', 'new.txt', 's.txt'].sort(),
    );
    expect(entries['a.txt']?.oid).toBe(blobOf('base\nstaged\nunstaged\n'));
    expect(entries['link.txt']).toEqual({ mode: '120000', oid: blobOf('a.txt') });
    expect(entries.nested?.mode).toBe('160000');

    // hash-object without -w gives add's blob for a file, and writes nothing; a link it hashes by
    // what it points at, so the core hashes a link's text itself.
    const before = count();
    const hashed = (file: string) =>
      runner.run({ cwd: tree, args: ['hash-object', '--', file], drivers });
    expect((await hashed('new.txt')).stdout.trim()).toBe(entries['new.txt']?.oid);
    expect((await hashed('link.txt')).stdout.trim()).not.toBe(entries['link.txt']?.oid);
    expect(count()).toBe(before);
    expect(heard()).toEqual([]);

    // The control: plain Git's add runs the filter.
    git(tree, { ...env, GIT_INDEX_FILE: path.join(root, 'control-index') }, 'add', '-A');
    expect(heard().length).toBeGreaterThan(0);

    // An agent that stops ignoring a copied file has add take it: the checkpoint must leave out
    // what the workspace's copy record names (C6), as add won't.
    writeFileSync(path.join(tree, '.gitignore'), '*.log\n');
    const again = makeTemporaryIndex(path.join(root, 'profile', 'workspaces', 'merge'), 'job-2');
    await runner.run({ cwd: tree, args: ['read-tree', tip], index: again, drivers });
    await runner.run({ cwd: tree, args: ['add', '-A'], index: again, drivers });
    const swept = (
      await runner.run({ cwd: tree, args: ['write-tree'], index: again, drivers })
    ).stdout.trim();
    expect(git(tree, env, 'ls-tree', '--name-only', swept)).toContain('.env');
  });

  it('resets an agent’s index to its checkpoint without touching a file (F11)', async () => {
    const at = path.join(root, 'r');
    makeRepository(at, env, { 'a.txt': 'base\n' });
    const tree = path.join(root, 'agent-tree');
    git(at, env, 'worktree', 'add', '-q', '-b', 'agent', tree);
    const tip = git(tree, env, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(tree, 'a.txt'), 'base\nwork\n');
    writeFileSync(path.join(tree, 'b.txt'), 'b\n');
    const index = makeTemporaryIndex(path.join(root, 'profile', 'workspaces', 'merge'), 'job-1');
    await runner.run({ cwd: tree, args: ['read-tree', tip], index });
    await runner.run({ cwd: tree, args: ['add', '-A'], index });
    const written = (await runner.run({ cwd: tree, args: ['write-tree'], index })).stdout.trim();
    const checkpoint = await runner.commitTree({
      cwd: tree,
      tree: written,
      parents: [tip],
      message: 'corrallm: commit uncommitted work before merging\n',
      author: CORRALLM,
      committer: CORRALLM,
      merge: { drivers: [] },
    });
    await runner.run({ cwd: tree, args: ['update-ref', 'refs/heads/agent', checkpoint, tip] });
    const files = listing(tree, (relative) => relative === '.git');
    // A two-way read-tree refuses the agent's index, which no longer matches its branch.
    expect(
      (await failed(runner.run({ cwd: tree, args: ['read-tree', '-m', checkpoint] })))?.fault,
    ).toBe('failed');
    await runner.run({ cwd: tree, args: ['read-tree', '--reset', checkpoint] });
    expect(
      (await runner.run({ cwd: tree, args: ['diff-index', '--cached', '--quiet', checkpoint] }))
        .code,
    ).toBe(0);
    expect(listing(tree, (relative) => relative === '.git')).toEqual(files);
    expect(git(tree, env, 'status', '--porcelain')).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('reading your checkout', () => {
  it('reads its status writing nothing, where plain status rewrites its index (F12)', async () => {
    const at = path.join(root, 'r');
    makeRepository(at, env, { 'x.txt': 'x\n' });
    // Stat-dirty: the same content, another time.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(at, 'x.txt'), later, later);
    const before = listing(path.join(at, '.git'));
    const status = await runner.run({
      cwd: at,
      args: [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=dirty',
      ],
    });
    expect(status.stdout).toBe('');
    expect(differing(before, listing(path.join(at, '.git')))).toEqual([]);
    // The control: plain status refreshes your index.
    await runner.run({ cwd: at, args: ['status', '--porcelain'] });
    expect(differing(before, listing(path.join(at, '.git')))).toEqual(['index']);
  });

  it('can’t see an edit to a file marked skip-worktree, which only ls-files -v shows (F12)', async () => {
    const at = path.join(root, 'r');
    makeRepository(at, env, { 'x.txt': 'x\n' });
    git(at, env, 'update-index', '--skip-worktree', 'x.txt');
    writeFileSync(path.join(at, 'x.txt'), 'edited\n');
    const status = await runner.run({
      cwd: at,
      args: ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'],
    });
    expect(status.stdout).toBe('');
    const flagged = await runner.run({ cwd: at, args: ['ls-files', '-v', '-z'] });
    expect(flagged.stdout).toBe('S x.txt\0');
  });
});
