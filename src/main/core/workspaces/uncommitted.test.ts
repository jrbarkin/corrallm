import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTemporaryIndex } from './merge-index';
import type { WorktreeRecord } from './store';
import { commit, git, gitInits, hooksInto, ran, sentinelProgram } from './test-git';
import { inventoryUncommitted, treeDigest } from './uncommitted';
import type { Uncommitted } from './uncommitted';
import { testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';

/*
 * An agent's uncommitted work (B9b Design §9 C2's digest, C6's eligibility), read over a real
 * worktree: each path whose files differ from its branch's tip, as `add -A` would store it, with
 * the digest a checkpoint is bound to. The digest is the one a core-owned temporary index's
 * `read-tree <tip>`, `add -A`, `write-tree` hashes to, over every kind of change; none when the
 * review can't promise that (partly staged, unmerged, a submodule or nested repository, a copied
 * local file, a filtered path, a name that isn't UTF-8, too many or too much). Reading it takes no
 * lock, writes nothing and runs no program a repository configures.
 */

// Real Git, a repository and a worktree each: slower under load.
vi.setConfig({ testTimeout: 60_000 });

let made: TestWorkspaces;
let tree: WorktreeRecord;
let at: string;
let tip: string;

beforeEach(async () => {
  made = await testWorkspaces({
    'README.md': 'hello\n',
    's.txt': 'staged\n',
    'del.txt': 'deleted\n',
    'gone.txt': 'removed\n',
    't.txt': 'becomes a link\n',
    '.gitignore': '*.log\n',
  });
  ({ tree } = await made.provision());
  at = tree.path;
  tip = g('rev-parse', 'HEAD');
});
afterEach(async () => {
  await made.close();
});

const g = (...args: string[]) => git(at, made.env, ...args).trim();

async function inventory(
  copied: readonly string[] | null = [],
  drivers?: readonly string[],
): Promise<Uncommitted> {
  const found = await inventoryUncommitted(made.git, {
    cwd: at,
    tip,
    drivers: drivers ?? (await made.git.inspect(at)).drivers,
    copied,
  });
  if (!found.ok) throw new Error(JSON.stringify(found.refusal));
  return found.value;
}

/** What a checkpoint would commit: its tree, made in a temporary index of the core's. */
async function checkpointTree(job = 'job-1'): Promise<string> {
  const index = makeTemporaryIndex(path.join(made.profile, 'workspaces', 'merge'), job);
  const { drivers } = await made.git.inspect(at);
  await made.git.run({ cwd: at, args: ['read-tree', tip], index, drivers });
  await made.git.run({ cwd: at, args: ['add', '-A'], index, drivers });
  return (await made.git.run({ cwd: at, args: ['write-tree'], index, drivers })).stdout.trim();
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
  writeFileSync(path.join(at, file), text);
}

describe.skipIf(process.platform === 'win32')('the uncommitted inventory', () => {
  it('is empty for a clean worktree: nothing to commit, so no digest', async () => {
    expect(await inventory()).toMatchObject({
      tip,
      files: [],
      changed: 0,
      untracked: 0,
      partlyStaged: 0,
      complete: true,
      digest: null,
    });
  });

  it('digests every kind of change as a checkpoint would commit it, reading without a lock or a write', async () => {
    write('README.md', 'changed\n');
    chmodSync(path.join(at, 'README.md'), 0o755);
    write('s.txt', 'staged, all of it\n');
    g('add', 's.txt');
    rmSync(path.join(at, 'del.txt'));
    g('rm', '-q', 'gone.txt');
    rmSync(path.join(at, 't.txt'));
    symlinkSync('README.md', path.join(at, 't.txt'));
    write('new.txt', 'new\n');
    write('dir/deep/n.txt', 'deep\n');
    write('run.sh', '#!/bin/sh\n');
    chmodSync(path.join(at, 'run.sh'), 0o755);
    symlinkSync('README.md', path.join(at, 'link'));
    write('ita.txt', 'intent\n');
    g('add', '-N', 'ita.txt');
    write('.gitattributes', '*.crlf text eol=lf\n');
    write('x.crlf', 'one\r\ntwo\r\n');
    write('naïve file.txt', 'unicode\n');
    write('debug.log', 'ignored\n');
    // Stat-dirty, same bytes: a plain status would rewrite the agent's index to refresh it.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(at, '.gitignore'), old, old);
    const index = g('rev-parse', '--git-path', 'index');
    const before = readFileSync(path.resolve(at, index));

    const found = await inventory();
    expect(readFileSync(path.resolve(at, index))).toEqual(before);
    expect(found.complete).toBe(true);
    expect(found.partlyStaged).toBe(0);
    expect(found.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(found.files.map((file) => [file.path, file.status, file.staged])).toEqual([
      ['.gitattributes', 'untracked', false],
      ['README.md', 'modified', false],
      ['del.txt', 'deleted', false],
      ['dir/deep/n.txt', 'untracked', false],
      ['gone.txt', 'deleted', true],
      ['ita.txt', 'added', false],
      ['link', 'untracked', false],
      ['naïve file.txt', 'untracked', false],
      ['new.txt', 'untracked', false],
      ['run.sh', 'untracked', false],
      ['s.txt', 'modified', true],
      ['t.txt', 'type-changed', false],
      ['x.crlf', 'untracked', false],
    ]);
    expect(found.changed).toBe(6);
    expect(found.untracked).toBe(7);
    const byPath = new Map(found.files.map((file) => [file.path, file]));
    expect(byPath.get('README.md')?.mode).toEqual({ old: '100644', new: '100755' });
    expect(byPath.get('run.sh')?.mode).toEqual({ old: null, new: '100755' });
    expect(byPath.get('del.txt')).toMatchObject({ oid: null, mode: { old: '100644', new: null } });
    // A link by its text, never what it points to.
    const linkText = execFileSync('git', ['hash-object', '--stdin'], {
      cwd: at,
      env: made.env,
      input: 'README.md',
    })
      .toString()
      .trim();
    expect(byPath.get('link')).toMatchObject({ oid: linkText, note: 'symlink' });
    expect(byPath.get('t.txt')).toMatchObject({ oid: linkText, mode: { new: '120000' } });

    // What a checkpoint commits hashes to exactly the digest reviewed.
    const checkpoint = await checkpointTree();
    expect(await treeDigest(made.git, { cwd: at, drivers: [] }, { tip, tree: checkpoint })).toBe(
      found.digest,
    );
    // Any other version of any file is another digest.
    write('new.txt', 'new, again\n');
    expect((await inventory()).digest).not.toBe(found.digest);
  });

  it('offers no commit for a partly staged path, whose index-only version a checkpoint would lose', async () => {
    write('s.txt', 'staged\nmore\n');
    g('add', 's.txt');
    write('s.txt', 'staged\nmore\nand unstaged\n');
    const found = await inventory();
    expect(found).toMatchObject({ partlyStaged: 1, digest: null });
    expect(found.files).toEqual([
      expect.objectContaining({ path: 's.txt', staged: true, partlyStaged: true }),
    ]);
    // Removed from the index but still on disk is partly staged too.
    g('checkout', '--', 's.txt');
    g('reset', '-q', 's.txt');
    g('rm', '-q', '--cached', 'README.md');
    expect(await inventory()).toMatchObject({ partlyStaged: 1, digest: null });
  });

  it('offers no commit for unmerged entries, a submodule, or a nested repository', async () => {
    const blob = g('rev-parse', 'HEAD:README.md');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: at,
      env: made.env,
      input: [1, 2, 3].map((stage) => `100644 ${blob} ${String(stage)}\tc.txt\n`).join(''),
    });
    expect((await inventory()).digest).toBeNull();
    g('reset', '-q', '--hard');
    g('update-index', '--add', '--cacheinfo', `160000,${tip},sub`);
    const gitlink = await inventory();
    expect(gitlink.digest).toBeNull();
    expect(gitlink.files).toEqual([expect.objectContaining({ path: 'sub', note: 'gitlink' })]);
    g('reset', '-q', '--hard');
    mkdirSync(path.join(at, 'nested'));
    git(path.join(at, 'nested'), made.env, 'init', '-q');
    writeFileSync(path.join(at, 'nested', 'n'), 'n\n');
    git(path.join(at, 'nested'), made.env, 'add', 'n');
    commit(path.join(at, 'nested'), made.env, 'n');
    const nested = await inventory();
    expect(nested.digest).toBeNull();
    expect(nested.files).toEqual([
      expect.objectContaining({ path: 'nested/', note: 'nested-repository' }),
    ]);
  });

  it('never commits a local file copied into the workspace, nor any when what was copied is unknown', async () => {
    write('.env', 'SECRET=1\n');
    write('new.txt', 'new\n');
    expect((await inventory([])).digest).not.toBeNull();
    expect(await inventory(['.env'])).toMatchObject({ digest: null });
    expect(await inventory(null)).toMatchObject({ digest: null });
    // A copied file the agent left alone (here, gone) doesn't stop it.
    rmSync(path.join(at, '.env'));
    expect((await inventory(['.env'])).digest).not.toBeNull();
  });

  it('offers no commit for a path a configured filter applies to, running no filter, hook or driver', async () => {
    const sentinel = path.join(made.root, 'ran');
    const program = sentinelProgram(made.root, sentinel);
    for (const key of ['clean', 'smudge', 'process']) {
      git(made.app, made.env, 'config', `filter.sent.${key}`, `${program} ${key}`);
    }
    git(made.app, made.env, 'config', 'filter.sent.required', 'true');
    git(made.app, made.env, 'config', 'merge.sent.driver', `${program} merge`);
    hooksInto(path.join(made.root, 'hooks-elsewhere'), program);
    git(made.app, made.env, 'config', 'core.hooksPath', path.join(made.root, 'hooks-elsewhere'));
    write('.gitattributes', '*.bin filter=sent\n*.raw filter=nobody\n');
    write('x.raw', 'raw\n');
    const unfiltered = await inventory();
    expect(unfiltered.digest).not.toBeNull();
    write('x.bin', 'filtered\n');
    expect(await inventory()).toMatchObject({ digest: null });
    expect(ran(sentinel)).toEqual([]);
  });

  it('offers no commit for an untracked file with another link, which Review changes doesn’t read', async () => {
    write('new.txt', 'new\n');
    expect((await inventory()).digest).not.toBeNull();
    // A second name for a file outside the worktree: its bytes are never the core's to show.
    writeFileSync(path.join(made.root, 'outside.txt'), 'elsewhere\n');
    linkSync(path.join(made.root, 'outside.txt'), path.join(at, 'linked.txt'));
    const found = await inventory();
    expect(found.digest).toBeNull();
    expect(found.files.find((file) => file.path === 'linked.txt')).toMatchObject({
      status: 'untracked',
      note: 'unreadable',
      oid: null,
    });
  });

  it('offers no commit while a tracked file has another link, changed or not', async () => {
    write('README.md', 'changed\n');
    expect((await inventory()).digest).not.toBeNull();
    // An unchanged tracked file with a second name elsewhere: no entry of its own, no digest.
    linkSync(path.join(at, 's.txt'), path.join(made.root, 's-second-name.txt'));
    const unchanged = await inventory();
    expect(unchanged.digest).toBeNull();
    expect(unchanged.files.map((file) => [file.path, file.note])).toEqual([
      ['README.md', undefined],
    ]);
    rmSync(path.join(made.root, 's-second-name.txt'));
    expect((await inventory()).digest).not.toBeNull();
    // A changed one: listed, unreadable, unhashed.
    linkSync(path.join(at, 'README.md'), path.join(made.root, 'readme-second-name.md'));
    const changed = await inventory();
    expect(changed.digest).toBeNull();
    expect(changed.files).toEqual([
      expect.objectContaining({
        path: 'README.md',
        status: 'modified',
        note: 'unreadable',
        oid: null,
      }),
    ]);
  });

  it('offers no commit while the agent’s index hides changes from status', async () => {
    write('README.md', 'changed\n');
    expect((await inventory()).digest).not.toBeNull();
    g('update-index', '--skip-worktree', 's.txt');
    expect(await inventory()).toMatchObject({ digest: null });
    g('update-index', '--no-skip-worktree', 's.txt');
    g('update-index', '--assume-unchanged', 's.txt');
    expect(await inventory()).toMatchObject({ digest: null });
  });

  it.skipIf(process.platform === 'darwin')(
    'shows a name that isn’t UTF-8 lossy, and offers no commit for it',
    async () => {
      writeFileSync(Buffer.from(path.join(at, 'bad-\xff.txt'), 'latin1'), 'x\n');
      const found = await inventory();
      expect(found.digest).toBeNull();
      expect(found.files).toEqual([
        expect.objectContaining({ status: 'untracked', note: 'lossy-name' }),
      ]);
    },
  );

  it('counts past 10,000 entries without listing them, incomplete, with no digest', async () => {
    mkdirSync(path.join(at, 'many'));
    for (let n = 0; n <= 10_000; n++) writeFileSync(path.join(at, 'many', String(n)), '');
    const found = await inventory();
    expect(found).toMatchObject({ complete: false, untracked: 10_001, digest: null });
    expect(found.files).toHaveLength(10_000);
  });

  it('hashes no more than 1 GiB: past it there is no digest', async () => {
    writeFileSync(path.join(at, 'big.bin'), '');
    truncateSync(path.join(at, 'big.bin'), 1024 * 1024 * 1024 + 1);
    const found = await inventory();
    expect(found.digest).toBeNull();
    expect(found.files).toEqual([
      expect.objectContaining({ path: 'big.bin', note: 'too-large', oid: null }),
    ]);
  });

  it('is a conflict when the worktree’s HEAD isn’t the tip it was asked about', async () => {
    write('a.txt', 'a\n');
    g('add', 'a.txt');
    commit(at, made.env, 'moved');
    const found = await inventoryUncommitted(made.git, { cwd: at, tip, drivers: [], copied: [] });
    expect(found).toMatchObject({
      ok: false,
      refusal: { code: 'conflict', reason: 'moved-source' },
    });
  });
});

describe.skipIf(process.platform === 'win32' || !gitInits('--object-format=sha256'))(
  'a SHA-256 repository',
  () => {
    it('digests its work as a checkpoint would commit it, links hashed by the core in its format', async () => {
      const sha = path.join(made.root, 'sha256');
      mkdirSync(sha);
      git(sha, made.env, 'init', '-q', '-b', 'main', '--object-format=sha256');
      writeFileSync(path.join(sha, 'a.txt'), 'a\n');
      git(sha, made.env, 'add', '-A');
      commit(sha, made.env, 'base');
      at = sha;
      tip = g('rev-parse', 'HEAD');
      expect(tip).toHaveLength(64);
      write('a.txt', 'changed\n');
      symlinkSync('a.txt', path.join(sha, 'link'));
      const found = await inventory();
      expect(found.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(found.files.find((file) => file.path === 'link')?.oid).toHaveLength(64);
      expect(
        await treeDigest(
          made.git,
          { cwd: sha, drivers: [] },
          { tip, tree: await checkpointTree() },
        ),
      ).toBe(found.digest);
    });
  },
);

describe.skipIf(process.platform === 'win32')('a tree’s digest', () => {
  it('is none for a tree a checkpoint can’t be: a submodule changed', async () => {
    g('update-index', '--add', '--cacheinfo', `160000,${tip},sub`);
    const tree = g('write-tree');
    expect(await treeDigest(made.git, { cwd: at, drivers: [] }, { tip, tree })).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')(
  'the worktree as Git reads it, whatever it configures',
  () => {
    it('counts a content edit whatever the repository’s stat settings, as a checkpoint commits it', async () => {
      const file = path.join(at, 'README.md');
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(file, old, old);
      g('update-index', '--refresh');
      g('config', 'core.trustctime', 'false');
      g('config', 'core.checkStat', 'minimal');
      // Past a timestamp's tick, an edit of the same size, its old modification time put back.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      writeFileSync(file, 'EDIT!\n');
      utimesSync(file, old, old);
      const review = await inventory();
      expect(review.files.map((entry) => entry.path)).toEqual(['README.md']);
      expect(review.digest).toBe(
        await treeDigest(made.git, { cwd: at, drivers: [] }, { tip, tree: await checkpointTree() }),
      );
    });
  },
);
