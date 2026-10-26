import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitRunner } from './git';
import type { GitIdentity } from './git';
import { makeTemporaryIndex } from './merge-index';
import { GitMetadataError, verifyMergeWrites } from './metadata';
import type { MergeWrites } from './metadata';
import { commit, differing, git, gitEnvironment, gitInits, listing, scratch } from './test-git';

/*
 * What a merge's Git writes (B9b Design §9 C10, F8), traced from what real Git writes and checked
 * by `verifyMergeWrites` as B9a's metadata is: preparation's loose objects, the install's
 * destination index, `logs/HEAD`, `ORIG_HEAD`, its branch's ref and log (or `reftable/`), and the
 * checkpoint's source index and logs. Each path Git wrote, moved out of the repository and linked
 * back, is refused before anything is written through it.
 */

// Real Git, a repository or two each: slower under load, or on Linux CI's emulated x64.
vi.setConfig({ testTimeout: 60_000 });

const REFTABLE = gitInits('--ref-format=reftable');
const YOU: GitIdentity = { name: 'Test', email: 'test@example.invalid' };

let root: string;
let remove: () => void;
let env: Record<string, string>;
let runner: GitRunner;

beforeEach(() => {
  ({ root, remove } = scratch('corrallm-merge-writes-'));
  env = gitEnvironment(path.join(root, 'home'));
  runner = new GitRunner({
    environment: () => Promise.resolve(env),
    hooks: path.join(root, 'hooks'),
  });
});
afterEach(() => {
  remove();
});

function change(at: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(at, file), text);
  git(at, env, 'add', '-A');
  commit(at, env, message);
  return git(at, env, 'rev-parse', 'HEAD').trim();
}

/**
 * In the checkout at `at` (made with `init`, or given), on `branch`: an agent branch and the
 * destination moved on, and M, prepared as the merge service prepares it. What Git wrote while
 * preparing it, besides objects, is checked to be nothing.
 */
async function prepared(
  at: string,
  branch: string,
): Promise<{ old: string; m: string; prepared: string[] }> {
  const old = change(at, { [`${branch}.txt`]: 'mine\n' }, branch);
  git(at, env, 'switch', '-q', '-c', `${branch}-agent`);
  const agent = change(at, { [`${branch}-agent.txt`]: 'theirs\n' }, 'agent');
  git(at, env, 'switch', '-q', branch);
  const ours = change(at, { [`${branch}.txt`]: 'mine, more\n' }, 'more');
  expect(ours).not.toBe(old);
  const common = git(at, env, 'rev-parse', '--git-common-dir').trim();
  const commonDir = path.resolve(at, common);
  const before = listing(commonDir);
  const { stdout } = await runner.run({
    cwd: at,
    args: ['merge-tree', '--write-tree', ours, agent],
    merge: { drivers: [] },
  });
  const m = await runner.commitTree({
    cwd: at,
    tree: stdout.trim(),
    parents: [ours, agent],
    message: `Merge branch '${branch}-agent' into ${branch}\n`,
    author: YOU,
    committer: YOU,
    merge: { drivers: [] },
  });
  return { old: ours, m, prepared: differing(before, listing(commonDir)) };
}

let moved = 0;

/** Moves `at` out of the repository and links it back, or links a new name there to outside. */
function linkOut(at: string): void {
  const outside = path.join(root, 'outside', String(moved++), path.basename(at));
  mkdirSync(path.dirname(outside), { recursive: true });
  if (existsSync(at)) renameSync(at, outside);
  else writeFileSync(outside, '');
  symlinkSync(outside, at);
}

function refusal(commonDir: string, writes: MergeWrites): string | undefined {
  try {
    verifyMergeWrites(commonDir, writes);
    return undefined;
  } catch (error) {
    if (error instanceof GitMetadataError) return error.code;
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('MergeWrites', () => {
  it('covers what preparing a merge writes: loose objects only, in folders of yours', async () => {
    const at = path.join(root, 'r');
    mkdirSync(at);
    git(at, env, 'init', '-q', '-b', 'main');
    change(at, { 'a.txt': 'a\n' }, 'base');
    const commonDir = path.join(at, '.git');
    const { prepared: written } = await prepared(at, 'main');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((one) => /^objects\/[0-9a-f]{2}(\/[0-9a-f]{38})?$/.test(one))).toBe(true);
    expect(refusal(commonDir, { objects: true })).toBeUndefined();
    // Alternates are sources Git only reads: allowed.
    mkdirSync(path.join(root, 'elsewhere-objects'));
    writeFileSync(
      path.join(commonDir, 'objects', 'info', 'alternates'),
      `${path.join(root, 'elsewhere-objects')}\n`,
    );
    expect(refusal(commonDir, { objects: true })).toBeUndefined();
    // A fan-out folder, or the object store itself, linked elsewhere is refused.
    const fanout = readdirSync(path.join(commonDir, 'objects')).find((name) =>
      /^[0-9a-f]{2}$/.test(name),
    );
    linkOut(path.join(commonDir, 'objects', fanout ?? ''));
    expect(refusal(commonDir, { objects: true })).toBe('symlinked');
    const fresh = path.join(root, 'fresh');
    mkdirSync(fresh);
    git(fresh, env, 'init', '-q', '-b', 'main');
    linkOut(path.join(fresh, '.git', 'objects'));
    expect(refusal(path.join(fresh, '.git'), { objects: true })).toBe('symlinked');
    // Asked about no object, it doesn't look there.
    expect(refusal(path.join(fresh, '.git'), {})).toBeUndefined();
  });

  it('covers a checkpoint’s file past core.bigFileThreshold, which Git streams into a pack', async () => {
    const at = path.join(root, 'r');
    mkdirSync(at);
    git(at, env, 'init', '-q', '-b', 'main');
    change(at, { 'a.txt': 'a\n' }, 'base');
    git(at, env, 'config', 'core.bigFileThreshold', '1k');
    writeFileSync(path.join(at, 'big.bin'), 'x'.repeat(8 * 1024));
    const commonDir = path.join(at, '.git');
    const before = listing(commonDir);
    const index = makeTemporaryIndex(path.join(root, 'profile', 'workspaces', 'merge'), 'job-1');
    await runner.run({ cwd: at, args: ['read-tree', 'HEAD'], index });
    await runner.run({ cwd: at, args: ['add', '-A'], index });
    const written = differing(before, listing(commonDir));
    expect(written.some((one) => one.startsWith('objects/pack/'))).toBe(true);
    expect(written.every((one) => one.startsWith('objects/'))).toBe(true);
    expect(refusal(commonDir, { objects: true })).toBeUndefined();
    linkOut(path.join(commonDir, 'objects', 'pack'));
    expect(refusal(commonDir, { objects: true })).toBe('symlinked');
  });

  it('covers everything the install writes in a main checkout, each path refused once it is a link', async () => {
    const template = path.join(root, 'template');
    mkdirSync(template);
    git(template, env, 'init', '-q', '-b', 'main');
    change(template, { 'a.txt': 'a\n' }, 'base');
    const { m } = await prepared(template, 'main');
    // Copies of the repository before its install, M prepared in each.
    const make = (name: string) => {
      const at = path.join(root, name);
      cpSync(template, at, { recursive: true });
      return { at };
    };
    const { at } = make('r');
    const commonDir = path.join(at, '.git');
    const writes: MergeWrites = { checkout: commonDir, branch: 'refs/heads/main' };
    expect(refusal(commonDir, writes)).toBeUndefined();
    const before = listing(commonDir, (relative) => relative === 'objects');
    await runner.install({ cwd: at, commit: m, merge: { drivers: [] } });
    const written = differing(
      before,
      listing(commonDir, (relative) => relative === 'objects'),
    );
    expect(written).toEqual([
      'ORIG_HEAD',
      'index',
      'logs/HEAD',
      'logs/refs/heads/main',
      'refs/heads/main',
    ]);
    expect(refusal(commonDir, writes)).toBeUndefined();
    // Each, and each folder along it, linked out of the repository is refused.
    const along = new Set(
      written.flatMap((one) =>
        one.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')),
      ),
    );
    for (const [i, one] of [...along].entries()) {
      const { at: again } = make(`again-${String(i)}`);
      const there = path.join(again, '.git');
      linkOut(path.join(there, one));
      expect(refusal(there, { checkout: there, branch: 'refs/heads/main' }), one).toBe('symlinked');
    }
    // A log Git appends to with another name too would write there as well.
    const { at: linked } = make('hard');
    linkSync(path.join(linked, '.git', 'logs', 'HEAD'), path.join(root, 'other-name'));
    expect(
      refusal(path.join(linked, '.git'), {
        checkout: path.join(linked, '.git'),
        branch: 'refs/heads/main',
      }),
    ).toBe('linked');
  });

  it('covers everything the install writes in a linked checkout, leaving the main one’s alone', async () => {
    const at = path.join(root, 'r');
    mkdirSync(at);
    git(at, env, 'init', '-q', '-b', 'main');
    change(at, { 'a.txt': 'a\n' }, 'base');
    const tree = path.join(root, 'picked');
    git(at, env, 'worktree', 'add', '-q', '-b', 'dest', tree);
    const { m } = await prepared(tree, 'dest');
    const commonDir = path.join(at, '.git');
    const gitDir = git(tree, env, 'rev-parse', '--absolute-git-dir').trim();
    const name = path.basename(gitDir);
    expect(gitDir).toBe(path.join(commonDir, 'worktrees', name));
    const before = listing(commonDir, (relative) => relative === 'objects');
    await runner.install({ cwd: tree, commit: m, merge: { drivers: [] } });
    expect(
      differing(
        before,
        listing(commonDir, (relative) => relative === 'objects'),
      ),
    ).toEqual([
      'logs/refs/heads/dest',
      'refs/heads/dest',
      `worktrees/${name}/ORIG_HEAD`,
      `worktrees/${name}/index`,
      `worktrees/${name}/logs/HEAD`,
    ]);
    const writes: MergeWrites = { checkout: gitDir, branch: 'refs/heads/dest' };
    expect(refusal(commonDir, writes)).toBeUndefined();
    for (const one of ['index', 'ORIG_HEAD', path.join('logs', 'HEAD'), 'logs']) {
      const target = path.join(gitDir, one);
      const kept = `${target}.kept`;
      renameSync(target, kept);
      symlinkSync(kept, target);
      expect(refusal(commonDir, writes), one).toBe('symlinked');
      rmSync(target);
      renameSync(kept, target);
    }
    expect(refusal(commonDir, writes)).toBeUndefined();
    // Only the repository's own Git directory or one of its registrations is a checkout's.
    expect(() => {
      verifyMergeWrites(commonDir, { checkout: path.join(root, 'elsewhere', '.git') });
    }).toThrow(TypeError);
  });

  it('covers a checkpoint’s writes in the agent’s checkout: its branch, its logs, its index', async () => {
    const at = path.join(root, 'r');
    mkdirSync(at);
    git(at, env, 'init', '-q', '-b', 'main');
    change(at, { 'a.txt': 'a\n' }, 'base');
    const tree = path.join(root, 'agent-tree');
    git(at, env, 'worktree', 'add', '-q', '-b', 'agent', tree);
    const tip = git(tree, env, 'rev-parse', 'HEAD').trim();
    const commonDir = path.join(at, '.git');
    const gitDir = git(tree, env, 'rev-parse', '--absolute-git-dir').trim();
    const name = path.basename(gitDir);
    const tree0 = git(tree, env, 'rev-parse', 'HEAD^{tree}').trim();
    const checkpoint = await runner.commitTree({
      cwd: tree,
      tree: tree0,
      parents: [tip],
      message: 'corrallm: commit uncommitted work before merging\n',
      author: YOU,
      committer: YOU,
      merge: { drivers: [] },
    });
    const before = listing(commonDir, (relative) => relative === 'objects');
    await runner.run({ cwd: tree, args: ['update-ref', 'refs/heads/agent', checkpoint, tip] });
    await runner.run({ cwd: tree, args: ['read-tree', '--reset', checkpoint] });
    const written = differing(
      before,
      listing(commonDir, (relative) => relative === 'objects'),
    );
    expect(written).toEqual([
      'logs/refs/heads/agent',
      'refs/heads/agent',
      `worktrees/${name}/index`,
      `worktrees/${name}/logs/HEAD`,
    ]);
    expect(
      refusal(commonDir, { objects: true, checkout: gitDir, branch: 'refs/heads/agent' }),
    ).toBeUndefined();
  });

  it.skipIf(!REFTABLE)(
    'covers what the install writes in a reftable repository: its tables (skipped where Git can’t make one, before 2.45)',
    async () => {
      const at = path.join(root, 'r');
      mkdirSync(at);
      git(at, env, 'init', '-q', '-b', 'main', '--ref-format=reftable');
      change(at, { 'a.txt': 'a\n' }, 'base');
      const { m } = await prepared(at, 'main');
      const commonDir = path.join(at, '.git');
      const before = listing(commonDir, (relative) => relative === 'objects');
      await runner.install({ cwd: at, commit: m, merge: { drivers: [] } });
      const written = differing(
        before,
        listing(commonDir, (relative) => relative === 'objects'),
      );
      expect(written.filter((one) => !one.startsWith('reftable/'))).toEqual(['index']);
      const writes: MergeWrites = { checkout: commonDir, branch: 'refs/heads/main' };
      expect(refusal(commonDir, writes)).toBeUndefined();
      linkOut(path.join(commonDir, 'reftable'));
      expect(refusal(commonDir, writes)).toBe('symlinked');
    },
  );

  it('refuses a Git directory that isn’t its real path', () => {
    const at = path.join(root, 'r');
    mkdirSync(at);
    git(at, env, 'init', '-q', '-b', 'main');
    change(at, { 'a.txt': 'a\n' }, 'base');
    const alias = path.join(root, 'alias');
    symlinkSync(path.join(at, '.git'), alias);
    expect(refusal(alias, { objects: true })).toBe('symlinked');
  });
});
