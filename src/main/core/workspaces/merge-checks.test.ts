import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintTrustedPath } from '../host';
import { GitRunner } from './git';
import {
  checkClean,
  checkFiltered,
  checkGitlinks,
  checkIgnored,
  checkIncoming,
  checkObjects,
  checkOrigHead,
  checkProtected,
  incomingChanges,
  readOrigHead,
  restoreOrigHead,
} from './merge-checks';
import type { IncomingChange } from './merge-checks';
import { findDestination } from './merge-select';
import type { MergeDestination, Selected } from './merge-select';
import { GitMetadataError } from './metadata';
import {
  commit,
  differing,
  git,
  gitInits,
  hooksInto,
  listing,
  ran,
  sentinelProgram,
} from './test-git';
import { testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * B9b's checks before a merge (Design §9 C4, C9, C11, and §9.3's steps 2, 4, 5 and 7), against
 * real Git in throwaway repositories, hostile ones included: your checkout clean as Git reads it
 * with no lock taken and nothing rewritten; the layouts merging refuses; what the merge would write
 * (into corrallm's own folder, a submodule, a file your repository filters, an object that isn't
 * there, over an ignored file); and ORIG_HEAD, read, recorded and put back as it was.
 */

// Real Git, a repository and a worktree or two each: slower under load.
vi.setConfig({ testTimeout: 60_000 });

const BRANCH = 'refs/heads/corrallm/0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b/agent';
/** Whether this Git keeps refs in reftable (2.45 and later), asked of it, never of its version. */
const REFTABLE = gitInits('--ref-format=reftable');

let made: TestWorkspaces;
/** A checkout of the same repository the incoming commits are made in, on branch `agent`. */
let side: string;

beforeEach(async () => {
  made = await testWorkspaces({
    'README.md': 'hello\n',
    '.gitignore': '*.log\nout\nbuild/\ngone/cache/\n*.tmp\n',
    'gone/t.txt': 'tracked\n',
  });
  side = path.join(made.root, 'side');
  g(made.app, 'worktree', 'add', '-q', '-b', 'agent', side);
});
afterEach(async () => {
  await made.close();
});

const g = (cwd: string, ...args: string[]) => git(cwd, made.env, ...args).trim();

function value<T>(selected: Selected<T>): T {
  if (!selected.ok) throw new Error(`Refused: ${JSON.stringify(selected.refusal)}`);
  return selected.value;
}

async function destination(picked = made.app): Promise<MergeDestination> {
  const recorded = await made.provisioner.repository(picked);
  if (recorded.kind !== 'repository') throw new Error(JSON.stringify(recorded));
  return value(
    await findDestination(made.git, {
      picked: mintTrustedPath(picked),
      repository: recorded.record,
    }),
  );
}

/** Writes `files` in `at` (null deletes one), then commits them all: the new HEAD. */
function work(at: string, files: Record<string, string | null>, message = 'work'): string {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(at, file);
    if (text === null) rmSync(full, { recursive: true, force: true });
    else {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  g(at, 'add', '-A', '--force');
  commit(at, made.env, message);
  return g(at, 'rev-parse', 'HEAD');
}

/** Test Git's identity, for commits a test makes by plumbing. */
const AS_TEST = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

/** An empty commit on the branch `at` is on: its id. */
function empty(at: string): string {
  g(at, ...AS_TEST, 'commit', '-q', '--allow-empty', '-m', 'empty');
  return g(at, 'rev-parse', 'HEAD');
}

/** What would come into your checkout from `to`: the changes from your branch's commit. */
async function incoming(into: MergeDestination, to: string): Promise<IncomingChange[]> {
  return value(await incomingChanges(made.git, into, { from: into.oid, to }));
}

describe.skipIf(process.platform === 'win32')('the clean check', () => {
  it('passes a clean checkout with ignored files, reading it with no lock taken and nothing rewritten', async () => {
    writeFileSync(path.join(made.app, 'debug.log'), 'ignored\n');
    // Stat-dirty, same bytes: a plain status would rewrite the index to refresh it.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(made.app, 'README.md'), old, old);
    const before = listing(path.join(made.app, '.git'));
    expect(await checkClean(made.git, await destination())).toBeUndefined();
    expect(differing(before, listing(path.join(made.app, '.git')))).toEqual([]);
  });

  it('refuses staged, unstaged, deleted and untracked work, naming up to five paths', async () => {
    const into = await destination();
    writeFileSync(path.join(made.app, 'README.md'), 'changed\n');
    const unstaged = await checkClean(made.git, into);
    expect(unstaged).toMatchObject({ code: 'refused', reason: 'dirty' });
    expect(unstaged?.sentence).toContain('"README.md"');
    g(made.app, 'add', 'README.md');
    expect(await checkClean(made.git, into)).toMatchObject({ reason: 'dirty' });
    g(made.app, 'reset', '-q', '--hard');
    g(made.app, 'rm', '-q', 'gone/t.txt');
    expect((await checkClean(made.git, into))?.sentence).toContain('"gone/t.txt"');
    g(made.app, 'reset', '-q', '--hard');
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      writeFileSync(path.join(made.app, `new-${String(n)}.txt`), '');
    }
    const untracked = await checkClean(made.git, into);
    expect(untracked).toMatchObject({ code: 'refused', reason: 'dirty' });
    expect(untracked?.sentence).toContain('"new-1.txt"');
    expect(untracked?.sentence).toContain('and 2 more');
    expect(untracked?.sentence).not.toContain('new-6.txt');
  });

  it('refuses unmerged entries, and each operation in progress in the checkout’s own Git directory', async () => {
    const into = await destination();
    const blob = g(made.app, 'rev-parse', 'HEAD:README.md');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: made.app,
      env: made.env,
      input: [1, 2, 3].map((stage) => `100644 ${blob} ${String(stage)}\tc.txt\n`).join(''),
    });
    expect(await checkClean(made.git, into)).toMatchObject({ code: 'refused', reason: 'unmerged' });
    g(made.app, 'reset', '-q', '--hard');
    const own = into.gitDir;
    for (const [name, folder] of [
      ['MERGE_HEAD', false],
      ['CHERRY_PICK_HEAD', false],
      ['REVERT_HEAD', false],
      ['BISECT_LOG', false],
      ['rebase-merge', true],
      ['rebase-apply', true],
      ['sequencer', true],
    ] as const) {
      const at = path.join(own, name);
      if (folder) mkdirSync(at);
      else writeFileSync(at, `${made.base}\n`);
      expect(await checkClean(made.git, into), name).toMatchObject({
        code: 'refused',
        reason: 'in-progress',
      });
      rmSync(at, { recursive: true, force: true });
    }
    expect(await checkClean(made.git, into)).toBeUndefined();
  });

  it('reads a linked pick’s own Git directory: the main checkout’s merge in progress isn’t its', async () => {
    const linked = path.join(made.root, 'linked');
    g(made.app, 'worktree', 'add', '-q', '-b', 'feature', linked);
    writeFileSync(path.join(made.app, '.git', 'MERGE_HEAD'), `${made.base}\n`);
    const into = await destination(linked);
    expect(await checkClean(made.git, into)).toBeUndefined();
    writeFileSync(path.join(into.gitDir, 'MERGE_HEAD'), `${made.base}\n`);
    expect(await checkClean(made.git, into)).toMatchObject({ reason: 'in-progress' });
  });

  it('is unavailable while another Git holds the index’s lock', async () => {
    const into = await destination();
    writeFileSync(path.join(into.gitDir, 'index.lock'), '');
    expect(await checkClean(made.git, into)).toMatchObject({
      code: 'unavailable',
      reason: 'index-lock',
    });
    rmSync(path.join(into.gitDir, 'index.lock'));
    // Or the locks of the refs the install updates: it would stop between your files and its ref.
    for (const lock of [
      path.join(into.gitDir, 'HEAD.lock'),
      path.join(into.gitDir, 'ORIG_HEAD.lock'),
      path.join(into.commonDir, 'refs', 'heads', 'main.lock'),
      path.join(into.commonDir, 'packed-refs.lock'),
    ]) {
      writeFileSync(lock, '');
      expect(await checkClean(made.git, into), lock).toMatchObject({
        code: 'unavailable',
        reason: 'ref-lock',
      });
      rmSync(lock);
    }
    expect(await checkClean(made.git, into)).toBeUndefined();
  });

  it.skipIf(!REFTABLE)('passes a clean repository keeping its refs in reftable', async () => {
    const tabled = path.join(made.root, 'tabled');
    mkdirSync(tabled);
    g(tabled, 'init', '-q', '-b', 'main', '--ref-format=reftable');
    work(tabled, { 'a.txt': 'a\n' });
    const into = await destination(tabled);
    expect(await checkClean(made.git, into)).toBeUndefined();
    expect(await checkOrigHead(made.git, into)).toBeUndefined();
  });

  it('refuses skip-worktree and assume-unchanged entries, which hide changes from status', async () => {
    const into = await destination();
    g(made.app, 'update-index', '--skip-worktree', 'README.md');
    writeFileSync(path.join(made.app, 'README.md'), 'hidden edit\n');
    expect(g(made.app, 'status', '--porcelain')).toBe('');
    const skipped = await checkClean(made.git, into);
    expect(skipped).toMatchObject({ code: 'refused', reason: 'index-flags' });
    expect(skipped?.sentence).toContain('"README.md"');
    g(made.app, 'update-index', '--no-skip-worktree', 'README.md');
    g(made.app, 'checkout', '--', 'README.md');
    g(made.app, 'update-index', '--assume-unchanged', 'gone/t.txt');
    expect(await checkClean(made.git, into)).toMatchObject({ reason: 'index-flags' });
  });

  it('refuses sparse checkouts and sparse or split indexes', async () => {
    const into = await destination();
    g(made.app, 'config', 'core.sparseCheckout', 'true');
    expect(await checkClean(made.git, into)).toMatchObject({ code: 'refused', reason: 'sparse' });
    g(made.app, 'config', '--unset', 'core.sparseCheckout');
    g(made.app, 'config', 'index.sparse', 'true');
    expect(await checkClean(made.git, into)).toMatchObject({ reason: 'sparse' });
    g(made.app, 'config', '--unset', 'index.sparse');
    g(made.app, 'config', 'core.splitIndex', 'true');
    expect(await checkClean(made.git, into)).toMatchObject({
      code: 'refused',
      reason: 'split-index',
    });
    g(made.app, 'config', '--unset', 'core.splitIndex');
    g(made.app, 'update-index', '--split-index');
    expect(await checkClean(made.git, into)).toMatchObject({ reason: 'split-index' });
    g(made.app, 'update-index', '--no-split-index');
    expect(await checkClean(made.git, into)).toBeUndefined();
  });

  it('refuses shallow repositories and grafts', async () => {
    const into = await destination();
    writeFileSync(path.join(into.commonDir, 'shallow'), `${made.base}\n`);
    expect(await checkClean(made.git, into)).toMatchObject({ code: 'refused', reason: 'shallow' });
    rmSync(path.join(into.commonDir, 'shallow'));
    mkdirSync(path.join(into.commonDir, 'info'), { recursive: true });
    writeFileSync(path.join(into.commonDir, 'info', 'grafts'), `${made.base}\n`);
    expect(await checkClean(made.git, into)).toMatchObject({ code: 'refused', reason: 'grafts' });
  });

  it('is unavailable on a Git older than merging needs, saying which it needs', async () => {
    const into = await destination();
    const bin = path.join(made.root, 'old-git');
    mkdirSync(bin);
    const old = path.join(bin, 'git');
    writeFileSync(
      old,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.38.1"; exit 0; fi\nexec git "$@"\n',
      { mode: 0o755 },
    );
    const runner = new GitRunner({ ...made.runnerDeps, executable: old });
    const refused = await checkClean(runner, into);
    expect(refused).toMatchObject({ code: 'unavailable', reason: 'git-unsupported' });
    expect(refused?.sentence).toMatch(/Git 2\.39 or later/);
  });

  it('runs no program a hostile repository configures, refusing a smudged file as changed', async () => {
    // Committed before the repository turns hostile: this test's own git runs nothing of it.
    const tip = work(side, { 'agent.txt': 'agent\n' });
    const sentinel = path.join(made.root, 'ran');
    const program = sentinelProgram(made.root, sentinel);
    hooksInto(path.join(made.app, '.git', 'hooks'), program);
    hooksInto(path.join(made.root, 'hooks-elsewhere'), program);
    g(made.app, 'config', 'core.hooksPath', path.join(made.root, 'hooks-elsewhere'));
    for (const key of ['clean', 'smudge', 'process']) {
      g(made.app, 'config', `filter.sent.${key}`, `${program} ${key}`);
    }
    g(made.app, 'config', 'filter.sent.required', 'true');
    g(made.app, 'config', 'merge.sent.driver', `${program} merge %A`);
    g(made.app, 'config', 'core.fsmonitor', program);
    g(made.app, 'config', 'diff.external', program);
    writeFileSync(path.join(made.app, '.git', 'info', 'attributes'), '* filter=sent merge=sent\n');
    const into = await destination();
    expect(into.drivers).toEqual(['sent']);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(made.app, 'README.md'), old, old);
    expect(await checkClean(made.git, into)).toBeUndefined();
    // A file your filter changed when it checked it out reads as changed with its filter blanked.
    writeFileSync(path.join(made.app, 'README.md'), 'smudged\n');
    const smudged = await checkClean(made.git, into);
    expect(smudged).toMatchObject({ reason: 'dirty' });
    expect(smudged?.sentence).toMatch(/git status/);
    await checkIncoming(made.git, into, { from: into.oid, to: tip, branch: BRANCH });
    expect(ran(sentinel)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('ORIG_HEAD', () => {
  it('reads it as it is: none, a commit, a symbolic ref, or what Git can’t read', async () => {
    const into = await destination();
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'none' });
    g(made.app, 'update-ref', 'ORIG_HEAD', made.base);
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'oid', oid: made.base });
    expect(await checkOrigHead(made.git, into)).toBeUndefined();
    g(made.app, 'branch', 'other');
    writeFileSync(path.join(into.gitDir, 'ORIG_HEAD'), 'ref: refs/heads/other\n');
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'symbolic' });
    expect(await checkOrigHead(made.git, into)).toMatchObject({
      code: 'refused',
      reason: 'orig-head',
    });
    // The clean check refuses it too.
    expect(await checkClean(made.git, into)).toMatchObject({ reason: 'orig-head' });
    writeFileSync(path.join(into.gitDir, 'ORIG_HEAD'), 'not a ref\n');
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'unreadable' });
    expect(await checkOrigHead(made.git, into)).toMatchObject({ code: 'unavailable' });
  });

  it('puts back what a refused fast-forward wrote: the commit recorded, or none', async () => {
    const tip = work(side, { 'gen.txt': 'tracked\n' });
    const into = await destination();
    const previous = empty(made.app);
    g(made.app, 'reset', '-q', '--hard', made.base);
    g(made.app, 'update-ref', 'ORIG_HEAD', previous);
    const recorded = await readOrigHead(made.git, into);
    expect(recorded).toEqual({ kind: 'oid', oid: previous });
    // An untracked file in the way: Git refuses, having written only ORIG_HEAD.
    writeFileSync(path.join(made.app, 'gen.txt'), 'mine\n');
    await expect(
      made.git.install({ cwd: made.app, commit: tip, merge: { drivers: [] } }),
    ).rejects.toThrow();
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'oid', oid: made.base });
    expect(await restoreOrigHead(made.git, into, { recorded: previous, wrote: made.base })).toBe(
      'restored',
    );
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'oid', oid: previous });
    // None recorded: none again.
    g(made.app, 'update-ref', '-d', 'ORIG_HEAD');
    await expect(
      made.git.install({ cwd: made.app, commit: tip, merge: { drivers: [] } }),
    ).rejects.toThrow();
    expect(await restoreOrigHead(made.git, into, { recorded: null, wrote: made.base })).toBe(
      'restored',
    );
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'none' });
  });

  it('leaves ORIG_HEAD alone unless it is what Git wrote, whatever it is', async () => {
    const into = await destination();
    const previous = empty(made.app);
    g(made.app, 'reset', '-q', '--hard', made.base);
    g(made.app, 'update-ref', 'ORIG_HEAD', previous);
    expect(await restoreOrigHead(made.git, into, { recorded: null, wrote: made.base })).toBe(
      'changed',
    );
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'oid', oid: previous });
    // A symbolic ORIG_HEAD: put back only by its own value, the ref it names unchanged.
    g(made.app, 'branch', 'other', previous);
    writeFileSync(path.join(into.gitDir, 'ORIG_HEAD'), 'ref: refs/heads/other\n');
    expect(await restoreOrigHead(made.git, into, { recorded: null, wrote: made.base })).toBe(
      'changed',
    );
    expect(g(made.app, 'rev-parse', 'refs/heads/other')).toBe(previous);
    g(made.app, 'update-ref', '--no-deref', 'refs/heads/other', made.base);
    expect(await restoreOrigHead(made.git, into, { recorded: previous, wrote: made.base })).toBe(
      'restored',
    );
    expect(g(made.app, 'rev-parse', 'refs/heads/other')).toBe(made.base);
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'oid', oid: previous });
  });

  it('puts back a linked pick’s own ORIG_HEAD, the main checkout’s left alone', async () => {
    const linked = path.join(made.root, 'linked');
    g(made.app, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const into = await destination(linked);
    const previous = empty(made.app);
    g(made.app, 'update-ref', 'ORIG_HEAD', previous);
    g(linked, 'update-ref', 'ORIG_HEAD', made.base);
    expect(readFileSync(path.join(into.gitDir, 'ORIG_HEAD'), 'utf8').trim()).toBe(made.base);
    expect(await restoreOrigHead(made.git, into, { recorded: null, wrote: made.base })).toBe(
      'restored',
    );
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'none' });
    expect(g(made.app, 'rev-parse', 'ORIG_HEAD')).toBe(previous);
  });

  it('writes nothing through a link where ORIG_HEAD’s log is', async () => {
    const into = await destination();
    g(made.app, 'update-ref', 'ORIG_HEAD', made.base);
    const outside = path.join(made.root, 'outside');
    writeFileSync(outside, '');
    symlinkSync(outside, path.join(into.gitDir, 'logs', 'ORIG_HEAD'));
    await expect(
      restoreOrigHead(made.git, into, { recorded: null, wrote: made.base }),
    ).rejects.toThrow(GitMetadataError);
    expect(readFileSync(outside, 'utf8')).toBe('');
    expect(await readOrigHead(made.git, into)).toEqual({ kind: 'oid', oid: made.base });
  });
});

describe.skipIf(process.platform === 'win32')('what a merge would write', () => {
  it('lists what comes in from your branch’s commit, by path, mode and object', async () => {
    const into = await destination();
    const tip = work(side, { 'a.txt': 'a\n', 'README.md': null, 'gone/t.txt': 'changed\n' });
    expect(await incoming(into, tip)).toEqual([
      expect.objectContaining({ path: 'README.md', status: 'deleted', newMode: '000000' }),
      expect.objectContaining({
        path: 'a.txt',
        status: 'added',
        oldMode: '000000',
        newMode: '100644',
      }),
      expect.objectContaining({ path: 'gone/t.txt', status: 'modified', lossy: false }),
    ]);
  });

  it('refuses anything coming into corrallm’s worktrees folder, case-folded where the filesystem is', async () => {
    const into = await destination();
    const under = work(side, { '.corral/worktrees/x/y.txt': 'y\n' });
    expect(checkProtected(into, await incoming(into, under))).toMatchObject({
      code: 'refused',
      reason: 'corral-worktrees',
    });
    g(side, 'reset', '-q', '--hard', made.base);
    const folder = work(side, { '.corral': 'a file\n' });
    expect(checkProtected(into, await incoming(into, folder))).toMatchObject({
      reason: 'corral-worktrees',
    });
    g(side, 'reset', '-q', '--hard', made.base);
    const cased = work(side, { '.CORRAL/Worktrees/x.txt': 'x\n' });
    const casedRefusal = checkProtected(into, await incoming(into, cased));
    if (into.ignoreCase) expect(casedRefusal).toMatchObject({ reason: 'corral-worktrees' });
    else expect(casedRefusal).toBeUndefined();
    g(side, 'reset', '-q', '--hard', made.base);
    // A code point HFS+ ignores in names makes no other name of it.
    const joiner = String.fromCodePoint(0x200c);
    const ignorable = work(side, { [`.corr${joiner}al/worktrees/x.txt`]: 'x\n' });
    expect(checkProtected(into, await incoming(into, ignorable))).toMatchObject({
      reason: 'corral-worktrees',
    });
    g(side, 'reset', '-q', '--hard', made.base);
    const elsewhere = work(side, { '.corral/notes.txt': 'n\n', 'src/.corral/worktrees/x': 'x\n' });
    expect(checkProtected(into, await incoming(into, elsewhere))).toBeUndefined();
  });

  it('refuses a merge that changes a submodule, saying how to merge it yourself', async () => {
    const into = await destination();
    g(side, 'update-index', '--add', '--cacheinfo', `160000,${made.base},sub`);
    commit(side, made.env, 'gitlink');
    const tip = g(side, 'rev-parse', 'HEAD');
    const refused = checkGitlinks(await incoming(into, tip), BRANCH);
    expect(refused).toMatchObject({ code: 'refused', reason: 'gitlink' });
    expect(refused?.sentence).toContain('"sub"');
    expect(refused?.sentence).toContain(
      'git merge --no-ff corrallm/0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b/agent',
    );
  });

  it('refuses writing a file your repository filters, naming it and giving the command to run yourself', async () => {
    work(made.app, { '.gitattributes': '*.bin filter=lfs\n*.raw filter=nobody\n' }, 'attributes');
    g(side, 'reset', '-q', '--hard', 'main');
    const filtered = work(side, { 'x.bin': 'pointer\n', 'y.txt': 'y\n', 'z.raw': 'z\n' });
    g(side, 'reset', '-q', '--hard', 'main');
    const plain = work(side, { 'y.txt': 'y\n', 'z.raw': 'z\n' });
    const attributes = work(side, { 'sub/.gitattributes': '*.txt -text\n' });
    // Configured where you merge (Git LFS, say), after the commits: never run by this test.
    g(made.app, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    g(made.app, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    const into = await destination();
    const refused = await checkFiltered(made.git, into, await incoming(into, filtered), BRANCH);
    expect(refused).toMatchObject({ code: 'refused', reason: 'filtered' });
    expect(refused?.sentence).toContain('"x.bin"');
    expect(refused?.sentence).not.toContain('y.txt');
    // An attribute naming a driver that isn't configured runs nothing.
    expect(refused?.sentence).not.toContain('z.raw');
    expect(refused?.sentence).toContain(
      'git merge --no-ff corrallm/0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b/agent',
    );
    expect(
      await checkFiltered(made.git, into, await incoming(into, plain), BRANCH),
    ).toBeUndefined();
    // A changed .gitattributes could filter any file, while any filter is configured.
    expect(
      await checkFiltered(made.git, into, await incoming(into, attributes), BRANCH),
    ).toMatchObject({ reason: 'attributes' });
  });

  it('checks no attribute where no filter is configured, a changed .gitattributes included', async () => {
    const into = await destination();
    expect(into.drivers).toEqual([]);
    const tip = work(side, { '.gitattributes': '*.bin filter=lfs\n', 'x.bin': 'x\n' });
    expect(await checkFiltered(made.git, into, await incoming(into, tip), BRANCH)).toBeUndefined();
  });

  it('refuses a name that isn’t UTF-8 where a filter is configured, rather than guess', async () => {
    g(made.app, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    const into = await destination();
    const blob = g(made.app, 'rev-parse', 'HEAD:README.md');
    const entries = execFileSync('git', ['ls-tree', '-z', 'HEAD'], {
      cwd: made.app,
      env: made.env,
    });
    const lossy = Buffer.concat([
      entries,
      Buffer.from(`100644 blob ${blob}\t`),
      Buffer.from([0x66, 0xff, 0x2e, 0x62, 0x69, 0x6e, 0]),
    ]);
    const tree = execFileSync('git', ['mktree', '-z'], {
      cwd: made.app,
      env: made.env,
      input: lossy,
    })
      .toString()
      .trim();
    const tip = g(made.app, ...AS_TEST, 'commit-tree', '-p', made.base, '-m', 'lossy', tree);
    const changes = await incoming(into, tip);
    expect(changes).toEqual([expect.objectContaining({ status: 'added', lossy: true })]);
    expect(await checkFiltered(made.git, into, changes, BRANCH)).toMatchObject({
      code: 'refused',
      reason: 'lossy-name',
    });
  });

  it('refuses a merge whose objects aren’t all in your repository, naming the files', async () => {
    const into = await destination();
    const tip = work(side, { 'a.txt': 'present\n', 'deep/b.txt': 'missing\n' });
    expect(
      await checkObjects(made.git, into, { from: into.oid, to: tip }, await incoming(into, tip)),
    ).toBeUndefined();
    const blob = g(made.app, 'rev-parse', `${tip}:deep/b.txt`);
    const loose = path.join(into.commonDir, 'objects', blob.slice(0, 2), blob.slice(2));
    renameSync(loose, path.join(made.root, 'hidden'));
    const refused = await checkObjects(
      made.git,
      into,
      { from: into.oid, to: tip },
      await incoming(into, tip),
    );
    expect(refused).toMatchObject({ code: 'refused', reason: 'missing-objects' });
    expect(refused?.sentence).toContain('"deep/b.txt"');
  });

  it('names ignored files where the merge writes, case-folded where the filesystem is; an ignored folder it adds a file into is fine', async () => {
    rmSync(path.join(side, 'gone'), { recursive: true, force: true });
    const tip = work(side, {
      'gen.log': 'tracked\n',
      'out/x.txt': 'x\n',
      'build/out.txt': 'built\n',
      gone: 'now a file\n',
      'case.tmp': 'lower\n',
    });
    writeFileSync(path.join(made.app, 'gen.log'), 'precious\n');
    writeFileSync(path.join(made.app, 'out'), 'precious\n');
    mkdirSync(path.join(made.app, 'build'));
    writeFileSync(path.join(made.app, 'build', 'keep.o'), 'obj\n');
    mkdirSync(path.join(made.app, 'gone', 'cache'), { recursive: true });
    writeFileSync(path.join(made.app, 'gone', 'cache', 'blob'), 'cached\n');
    writeFileSync(path.join(made.app, 'CASE.tmp'), 'upper\n');
    const into = await destination();
    const { refusal, skipped } = await checkIgnored(made.git, into, await incoming(into, tip));
    expect(skipped).toBe(false);
    expect(refusal).toMatchObject({ code: 'refused', reason: 'ignored-collision' });
    for (const named of ['"gen.log"', '"out"', '"gone/cache/"']) {
      expect(refusal?.sentence).toContain(named);
    }
    expect(refusal?.sentence).not.toContain('build');
    if (into.ignoreCase) expect(refusal?.sentence).toContain('"CASE.tmp"');
    else expect(refusal?.sentence).not.toContain('CASE.tmp');
    // Past its bound it is skipped: Git's own check at the install is the guarantee.
    expect(await checkIgnored(made.git, into, await incoming(into, tip), { maxBytes: 8 })).toEqual({
      skipped: true,
    });
  });

  it('runs every check of what comes in, in order, passing an ordinary merge', async () => {
    const into = await destination();
    const tip = work(side, { 'a.txt': 'a\n', 'src/b.txt': 'b\n' });
    expect(
      await checkIncoming(made.git, into, { from: into.oid, to: tip, branch: BRANCH }),
    ).toBeUndefined();
    g(side, 'update-index', '--add', '--cacheinfo', `160000,${made.base},sub`);
    commit(side, made.env, 'gitlink');
    expect(
      await checkIncoming(made.git, into, {
        from: into.oid,
        to: g(side, 'rev-parse', 'HEAD'),
        branch: BRANCH,
      }),
    ).toMatchObject({ reason: 'gitlink' });
  });
});

describe.skipIf(process.platform === 'win32')('ORIG_HEAD’s log', () => {
  it('is never appended to through another name of it', async () => {
    const into = await destination();
    g(made.app, 'update-ref', 'ORIG_HEAD', made.base);
    const other = path.join(made.root, 'other-name');
    writeFileSync(path.join(into.gitDir, 'logs', 'ORIG_HEAD'), '');
    linkSync(path.join(into.gitDir, 'logs', 'ORIG_HEAD'), other);
    await expect(
      restoreOrigHead(made.git, into, { recorded: null, wrote: made.base }),
    ).rejects.toThrow(GitMetadataError);
    expect(readFileSync(other, 'utf8')).toBe('');
  });
});
