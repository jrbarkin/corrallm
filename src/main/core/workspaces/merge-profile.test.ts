import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SAFE_GIT_OPTIONS } from '../../git';
import { Children } from '../children';
import {
  GitError,
  GitRunner,
  INSTALL_TIMEOUT_MS,
  MERGE_GIT_VERSION,
  MERGE_TIMEOUT_MS,
} from './git';
import type { GitRunnerDeps } from './git';
import { makeTemporaryIndex, removeTemporaryIndex } from './merge-index';
import { fakeGit, git, gitEnvironment, makeRepository, ran, scratch } from './test-git';

/*
 * The runner's merge profile (B9b Design §9 C7, C9 and C2's paging): what a call computing,
 * preparing or installing a merge adds to every call's fixed options, the install's and a merge
 * commit's own fixed flags, the floor merging needs, the capped reading Review changes pages
 * with, and the merge service's temporary index. A stand-in git shows what Git is given; real Git
 * (merge-hostile.test.ts) shows what that keeps from running.
 */

let root: string;
let remove: () => void;
let home: string;
let hooks: string;
let env: Record<string, string>;

beforeEach(() => {
  ({ root, remove } = scratch());
  home = path.join(root, 'home');
  hooks = path.join(root, 'hooks');
  env = gitEnvironment(home);
});
afterEach(() => {
  remove();
});

function runner(deps: Partial<GitRunnerDeps> = {}): GitRunner {
  return new GitRunner({ environment: () => Promise.resolve(env), hooks, ...deps });
}

async function failure(promise: Promise<unknown>): Promise<GitError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitError) return error;
    throw error;
  }
  throw new Error('It ran.');
}

/** A stand-in git that prints each argument it is given, NUL-terminated. */
function echoing(version = '2.50.1'): string {
  const dir = path.join(root, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'git');
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nfor a in "$@"; do printf "%s\\0" "$a"; done\n`,
    { mode: 0o755 },
  );
  return file;
}

const argsOf = (stdout: string) => stdout.split('\0').slice(0, -1);

/** Every call's fixed options, as the runner gives them (git.test.ts pins them). */
function fixed(): string[] {
  return [
    ...SAFE_GIT_OPTIONS,
    '-c',
    `core.hooksPath=${hooks}`,
    '-c',
    'submodule.recurse=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'worktree.useRelativePaths=false',
  ];
}

const OID = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

describe.skipIf(process.platform === 'win32')('the merge profile', () => {
  it('adds to every call’s options: replace refs ignored, renormalization off, and every custom merge driver blanked', async () => {
    const { stdout } = await runner({ executable: echoing() }).run({
      cwd: root,
      args: ['merge-tree', '--write-tree', OID, OTHER],
      drivers: ['lfs'],
      merge: { drivers: ['sent', 'Other.Name'] },
      config: ['merge.renormalize=true'],
    });
    expect(argsOf(stdout)).toEqual([
      '-c',
      'merge.renormalize=true',
      ...fixed(),
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
      // Its own after the call's, so they win.
      '-c',
      'merge.renormalize=false',
      '-c',
      'merge.Other.Name.driver=',
      '-c',
      'merge.sent.driver=',
      '--no-replace-objects',
      'merge-tree',
      '--write-tree',
      OID,
      OTHER,
    ]);
  });

  it('ignores replace refs on a call that asks, without the rest of the profile', async () => {
    const { stdout } = await runner({ executable: echoing() }).run({
      cwd: root,
      args: ['diff', OID, OTHER],
      noReplaceObjects: true,
    });
    expect(argsOf(stdout)).toEqual([...fixed(), '--no-replace-objects', 'diff', OID, OTHER]);
  });

  it('refuses a custom merge driver it can’t name with -c, before running anything', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, `echo ran >> '${path.join(root, 'ran')}'`);
    const refused = await failure(
      runner({ executable: stand }).run({
        cwd: root,
        args: ['merge-tree', '--write-tree', OID, OTHER],
        merge: { drivers: ['x=y'] },
      }),
    );
    expect(refused.fault).toBe('config');
    expect(refused.message).toMatch(/merge driver x=y/);
    expect(ran(path.join(root, 'ran'))).toEqual([]);
  });

  it('merges only from Git 2.39: an older Git refuses a merge’s calls, and still runs the rest', async () => {
    expect(MERGE_GIT_VERSION).toEqual([2, 39]);
    const old = runner({ executable: echoing('2.38.1') });
    expect(argsOf((await old.run({ cwd: root, args: ['status'] })).stdout)).toContain('status');
    for (const call of [
      old.run({
        cwd: root,
        args: ['merge-tree', '--write-tree', OID, OTHER],
        merge: { drivers: [] },
      }),
      old.run({ cwd: root, args: ['status'], needs: MERGE_GIT_VERSION }),
      old.install({ cwd: root, commit: OID, merge: { drivers: [] } }),
      old.commitTree({
        cwd: root,
        tree: TREE,
        parents: [OID],
        message: 'm',
        author: { name: 'A', email: 'a@example.invalid' },
        committer: { name: 'A', email: 'a@example.invalid' },
        merge: { drivers: [] },
      }),
    ]) {
      const refused = await failure(call);
      expect(refused.fault).toBe('git-unsupported');
      expect(refused.message).toMatch(/Git 2\.39 or later; this is git version 2\.38\.1/);
    }
    // A floor of its own, newer still, is a call's to ask.
    expect(
      (
        await failure(
          runner({ executable: echoing('2.39.5') }).run({
            cwd: root,
            args: ['status'],
            needs: [2, 45],
          }),
        )
      ).fault,
    ).toBe('git-unsupported');
    const current = runner({ executable: echoing('2.39.5') });
    await current.run({ cwd: root, args: ['status'], merge: { drivers: [] } });
  });

  it('installs a prepared commit only by fast-forward, with its fixed flags, over its longer bound', async () => {
    expect(MERGE_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(INSTALL_TIMEOUT_MS).toBe(30 * 60 * 1000);
    const git2 = runner({ executable: echoing() });
    const { stdout } = await git2.install({
      cwd: root,
      commit: OID,
      drivers: ['lfs'],
      merge: { drivers: ['sent'] },
    });
    const args = argsOf(stdout);
    expect(args.slice(args.indexOf('--no-replace-objects'))).toEqual([
      '--no-replace-objects',
      'merge',
      '--ff-only',
      '--no-overwrite-ignore',
      '--no-verify-signatures',
      '--no-autostash',
      '--no-stat',
      '--no-squash',
      '--no-edit',
      '-q',
      OID,
    ]);
    expect(args).toEqual(expect.arrayContaining(['merge.sent.driver=', 'filter.lfs.smudge=']));
    // Only a commit's object id, never a name Git would look up or read as an option.
    for (const commit of ['main', '-q', `${OID}x`, 'HEAD', OID.toUpperCase(), '']) {
      await expect(git2.install({ cwd: root, commit, merge: { drivers: [] } })).rejects.toThrow(
        TypeError,
      );
    }
  });

  it('gives commit-tree the identities given, commit.gpgSign off and --no-gpg-sign, and its message whole', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    const seen = path.join(root, 'seen');
    // Prints a commit id, as commit-tree does, having kept its arguments.
    const stand = fakeGit(
      dir,
      `for a in "$@"; do printf "%s\\0" "$a"; done > '${seen}'\necho ${'d'.repeat(40)}`,
    );
    const message =
      'corrallm: commit uncommitted work before merging\n\nCorrallm-Requested-By: outside:bot\n';
    const oid = await runner({ executable: stand }).commitTree({
      cwd: root,
      tree: TREE,
      parents: [OID, OTHER],
      message,
      author: { name: 'corrallm', email: 'noreply@corrallm.invalid' },
      committer: { name: 'corrallm', email: 'noreply@corrallm.invalid' },
      merge: { drivers: ['sent'] },
    });
    expect(oid).toBe('d'.repeat(40));
    // What it answers is checked to be an object id, never taken as one.
    const wrong = fakeGit(dir, `echo 'not an id'`);
    const refused = await failure(
      runner({ executable: wrong }).commitTree({
        cwd: root,
        tree: TREE,
        parents: [OID],
        message,
        author: { name: 'corrallm', email: 'noreply@corrallm.invalid' },
        committer: { name: 'corrallm', email: 'noreply@corrallm.invalid' },
        merge: { drivers: [] },
      }),
    );
    expect(refused.fault).toBe('failed');
    const args = argsOf(readFileSync(seen, 'utf8'));
    expect(args.slice(0, 8)).toEqual([
      '-c',
      'author.name=corrallm',
      '-c',
      'author.email=noreply@corrallm.invalid',
      '-c',
      'committer.name=corrallm',
      '-c',
      'committer.email=noreply@corrallm.invalid',
    ]);
    expect(args.slice(args.indexOf('--no-replace-objects'))).toEqual([
      '--no-replace-objects',
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      '--no-gpg-sign',
      '-p',
      OID,
      '-p',
      OTHER,
      '-m',
      message,
      TREE,
    ]);
  });

  it('refuses an identity or message Git would read otherwise, and parents or a tree that aren’t object ids', async () => {
    const git2 = runner({ executable: echoing() });
    const call = {
      cwd: root,
      tree: TREE,
      parents: [OID],
      message: 'm',
      author: { name: 'A', email: 'a@example.invalid' },
      committer: { name: 'A', email: 'a@example.invalid' },
      merge: { drivers: [] },
    };
    for (const wrong of [
      { author: { name: 'A <b@c>', email: 'a@example.invalid' } },
      { committer: { name: 'A', email: 'a@example.invalid>\nx' } },
      { author: { name: '', email: 'a@example.invalid' } },
      { message: 'nul\0' },
      { message: '' },
      { tree: 'HEAD' },
      { parents: [] },
      { parents: ['-p'] },
    ]) {
      await expect(git2.commitTree({ ...call, ...wrong })).rejects.toThrow(TypeError);
    }
  });
});

describe.skipIf(process.platform === 'win32')('inspect: custom merge drivers', () => {
  it('names every merge driver configured where the call runs, conditional includes as they apply there', async () => {
    const here = path.join(root, 'here');
    makeRepository(here, env);
    git(here, env, 'config', 'merge.sent.driver', 'sentinel %O %A %B');
    git(here, env, 'config', 'merge.Other.Name.driver', 'other');
    git(here, env, 'config', 'merge.Other.Name.recursive', 'binary');
    git(here, env, 'config', 'merge.renormalize', 'true');
    git(here, env, 'config', 'merge.default', 'sent');
    const late = path.join(root, 'late.config');
    writeFileSync(late, '[merge "late"]\n\tdriver = late\n');
    git(here, env, 'config', 'includeIf.onbranch:feature/**.path', late);
    const git2 = runner();
    expect((await git2.inspect(here)).mergeDrivers).toEqual(['Other.Name', 'sent']);
    git(here, env, 'checkout', '-q', '-b', 'feature/x');
    expect((await git2.inspect(here)).mergeDrivers).toEqual(['Other.Name', 'late', 'sent']);
    // One -c can't name is still named: a merge's call refuses it, nothing else does.
    git(here, env, 'config', 'merge.x=y.driver', 'evil');
    const inspected = await git2.inspect(here);
    expect(inspected.mergeDrivers).toContain('x=y');
    expect(inspected.refusals).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('capped reading', () => {
  it('reads up to its cap, then ends the git and answers what it read, cut', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, `head -c 2000000 /dev/zero | tr '\\0' 'a'`);
    const read = await runner({ executable: stand }).capped({
      cwd: root,
      args: ['diff'],
      cap: 65_536,
    });
    expect(read.cut).toBe(true);
    expect(read.code).toBeNull();
    expect(read.stdout).toBe('a'.repeat(65_536));
  });

  it('answers a whole read under its cap uncut, with Git’s exit code', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, `printf 'one\\ntwo\\n'; exit 1`);
    expect(
      await runner({ executable: stand }).capped({
        cwd: root,
        args: ['diff'],
        cap: 8,
        answers: [1],
      }),
    ).toEqual({ code: 1, stdout: 'one\ntwo\n', stderr: '', cut: false });
  });

  it('never cuts inside a character, and stays within its cap in UTF-8 bytes', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, `i=0; while [ $i -lt 40000 ]; do printf 'é'; i=$((i+1)); done`);
    const read = await runner({ executable: stand }).capped({
      cwd: root,
      args: ['diff'],
      cap: 4_097,
    });
    expect(read.cut).toBe(true);
    expect(Buffer.byteLength(read.stdout)).toBeLessThanOrEqual(4_097);
    expect(read.stdout).toBe('é'.repeat(2_048));
  });

  it('never reads a failed, killed or garrulous git as a short page', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const failed = fakeGit(dir, `printf 'part'; echo fatal >&2; exit 128`);
    expect(
      (await failure(runner({ executable: failed }).capped({ cwd: root, args: ['diff'], cap: 64 })))
        .fault,
    ).toBe('failed');
    const slow = fakeGit(dir, `printf 'part'; sleep 30`);
    expect(
      (
        await failure(
          runner({ executable: slow }).capped({
            cwd: root,
            args: ['diff'],
            cap: 64,
            timeoutMs: 300,
          }),
        )
      ).fault,
    ).toBe('timeout');
    // Its cap is for what it reads, not for what git says went wrong.
    const loud = fakeGit(dir, `head -c 2000000 /dev/zero >&2; printf 'ok'`);
    expect(
      (
        await failure(
          runner({ executable: loud }).capped({ cwd: root, args: ['diff'], cap: 65_536 }),
        )
      ).fault,
    ).toBe('output');
  });

  it('ends the cut git’s whole process group, as the core’s child', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const pids = path.join(root, 'pids');
    const stand = fakeGit(dir, `sleep 30 & echo $! > '${pids}'; head -c 2000000 /dev/zero`);
    const children = new Children(path.join(root, 'profile'));
    await children.recover();
    const read = await runner({ executable: stand, processes: children }).capped({
      cwd: root,
      args: ['diff'],
      cap: 4_096,
    });
    expect(read).toMatchObject({ cut: true, code: null });
    expect(Buffer.byteLength(read.stdout)).toBe(4_096);
    await children.flush();
    const grandchild = Number(readFileSync(pids, 'utf8'));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('the temporary index', () => {
  it('is a core-made path in a private folder of the profile’s, one per job, which Git is pointed at only through it', async () => {
    const folder = path.join(root, 'profile', 'workspaces', 'merge');
    const index = makeTemporaryIndex(folder, 'job-1');
    expect(index).toBe(path.join(folder, 'job-1', 'index'));
    for (const at of [folder, path.dirname(index)]) {
      const found = lstatSync(at);
      expect(found.isDirectory()).toBe(true);
      expect(found.mode & 0o777).toBe(0o700);
    }
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, 'env');
    env = { ...env, GIT_INDEX_FILE: '/elsewhere/index' };
    const seen = (stdout: string) =>
      stdout.split('\n').filter((line) => line.startsWith('GIT_INDEX_FILE='));
    const git2 = runner({ executable: stand });
    expect(seen((await git2.run({ cwd: root, args: ['status'] })).stdout)).toEqual([]);
    expect(seen((await git2.run({ cwd: root, args: ['add', '-A'], index })).stdout)).toEqual([
      `GIT_INDEX_FILE=${index}`,
    ]);
    // A job's folder is made once: a second job of its id, or one already there, is refused.
    expect(() => makeTemporaryIndex(folder, 'job-1')).toThrow();
    removeTemporaryIndex(folder, 'job-1');
    expect(existsSync(path.dirname(index))).toBe(false);
    removeTemporaryIndex(folder, 'job-1');
  });

  it('refuses a job id that isn’t one, and a folder that isn’t the profile’s alone', () => {
    const folder = path.join(root, 'profile', 'workspaces', 'merge');
    for (const job of ['', '.', '..', 'a/b', '-x', 'x'.repeat(65), 'a b']) {
      expect(() => makeTemporaryIndex(folder, job)).toThrow(TypeError);
    }
    const other = path.join(root, 'other');
    mkdirSync(other);
    const linked = path.join(root, 'linked');
    symlinkSync(other, linked);
    expect(() => makeTemporaryIndex(linked, 'job-1')).toThrow(/isn’t a folder of its own/);
    const open = path.join(root, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(() => makeTemporaryIndex(open, 'job-1')).toThrow(/may be written by others/);
    expect(readdirSync(other)).toEqual([]);
  });
});
