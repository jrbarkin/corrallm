import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BranchDiffOutput } from '../../../shared/api/branch';
import type { BranchFile } from '../../../shared/api/branch';
import type { OpResult } from '../../../shared/api/errors';
import { MAX_PAGE_BYTES } from '../../../shared/api/limits';
import type { CanvasDocument, CanvasNode } from '../../../shared/model/canvas';
import { untrackedFilePatch } from '../../../shared/model/branch-patch';
import { mintTrustedPath } from '../host';
import { readBranchDiff } from './diff';
import type { BranchDiffDeps, BranchDiffRequest } from './diff';
import { GitRunner } from './git';
import type { CappedOutput, GitCall } from './git';
import { listWorktrees } from './list';
import { REPLACEMENT } from './merge-checks';
import type { WorktreeRecord } from './store';
import { commit, git, gitInits, hooksInto, listing, ran, sentinelProgram } from './test-git';
import { CANVAS, testWorkspaces } from './test-workspace';
import type { TestWorkspaces } from './test-workspace';
import { inventoryUncommitted } from './uncommitted';

/*
 * B9b's diff service (Design §4, §9 C2, C3): an agent's branch for review, one bounded page at a
 * time, against real Git in throwaway repositories. Its committed work is the recorded base to its
 * branch's tip; its uncommitted work, separately, as its worktree has it. Untracked files are read
 * by the core, never through a link. Paging retains nothing: every page reads everything again and
 * refuses a continuation once the work changed, so a page never mixes two states. A review reads
 * only: no repository program runs, nothing is written, and no worktree is made or repaired.
 */

// Real Git, a repository and a worktree or two each: slower under load.
vi.setConfig({ testTimeout: 120_000 });

let made: TestWorkspaces;

beforeEach(async () => {
  made = await testWorkspaces({
    'README.md': 'hello\n',
    'old.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n',
    'gone.txt': 'gone\n',
    'run.sh': '#!/bin/sh\n',
    'a.txt': 'a\n',
    'b.txt': 'b\n',
    '.gitignore': '*.log\n',
  });
});
afterEach(async () => {
  await made.close();
});

function node(id: string, parentId?: string): CanvasNode {
  return {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    ...(parentId === undefined ? {} : { parentId }),
    data: { label: id.charAt(0).toUpperCase() + id.slice(1), queue: [] },
  };
}

/** Builder works alone; Lead heads a group with Helper, one tree between them. */
const DOCUMENT: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [node('builder'), node('lead'), node('helper', 'lead')],
  links: [],
};

const g = (cwd: string, ...args: string[]) => git(cwd, made.env, ...args).trim();

function write(at: string, file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
  writeFileSync(path.join(at, file), text);
}

/** Commits `files` in the checkout at `at`: its new HEAD. */
function work(at: string, files: Record<string, string>, message = 'work'): string {
  for (const [file, text] of Object.entries(files)) write(at, file, text);
  g(at, 'add', '-A');
  commit(at, made.env, message);
  return g(at, 'rev-parse', 'HEAD');
}

/** A workspace for `owner`, its agents bound to it on the canvas, ready. */
async function bound(owner = 'agent/builder', agents = ['builder']): Promise<WorktreeRecord> {
  const { tree } = await made.provision(owner as `agent/${string}`);
  const repository = await made.repository();
  await made.workspaces.write((w) => {
    w.bindCanvas(CANVAS, repository.id);
    for (const agent of agents) w.bind(CANVAS, agent, tree.id);
    w.transition(tree.id, { from: 'setup', to: 'ready' });
  });
  const kept = made.workspaces.worktree(tree.id);
  if (kept === undefined) throw new Error('No workspace.');
  return kept;
}

function deps(over: Partial<BranchDiffDeps> = {}): BranchDiffDeps {
  return {
    git: made.git,
    workspaces: made.workspaces,
    projectRoot: () => mintTrustedPath(made.app),
    copied: () => [],
    list: (canvas, viewer) =>
      Promise.resolve(
        listWorktrees(
          { workspaces: made.workspaces, projectRoot: () => made.app, kept: () => [] },
          canvas,
          DOCUMENT,
          viewer,
        ),
      ),
    nameOf: (_canvas, agent) => agent.charAt(0).toUpperCase() + agent.slice(1),
    ...over,
  };
}

function page(
  request: Partial<BranchDiffRequest> = {},
  over: Partial<BranchDiffDeps> = {},
): Promise<OpResult<BranchDiffOutput>> {
  return readBranchDiff(deps(over), {
    canvas: CANVAS,
    agent: 'builder',
    limit: 50,
    viewer: { kind: 'you' },
    ...request,
  });
}

function value<T>(result: OpResult<T>): T {
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const byPath = (files: readonly BranchFile[], section: BranchFile['section']) =>
  new Map(files.filter((file) => file.section === section).map((file) => [file.path, file]));

/** Every page of the review, in order, `limit` entries at most each. */
async function pages(limit: number, request: Partial<BranchDiffRequest> = {}) {
  const found: BranchDiffOutput[] = [];
  let after: string | undefined;
  for (;;) {
    const one = value(await page({ ...request, limit, after }));
    found.push(one);
    if (one.next === null) return found;
    after = one.next;
  }
}

/** A runner whose next uncommitted patch first runs `race`: the work changing as it's read. */
class Racing extends GitRunner {
  race: (() => void) | undefined;
  override async capped(call: GitCall & { cap: number }): Promise<CappedOutput> {
    const race = this.race;
    if (race !== undefined && call.args.includes('diff') && call.args.includes('--no-renames')) {
      this.race = undefined;
      race();
    }
    return super.capped(call);
  }
}

describe.skipIf(process.platform === 'win32')('Review changes', () => {
  it('lists the committed work against the recorded base, then the uncommitted work, each with its patch, writing nothing', async () => {
    const tree = await bound();
    const at = tree.path;
    write(at, 'README.md', 'hello\nworld\n');
    write(at, 'new.txt', 'new\n');
    rmSync(path.join(at, 'gone.txt'));
    g(at, 'mv', 'old.txt', 'moved.txt');
    symlinkSync('README.md', path.join(at, 'link'));
    write(at, 'blob.bin', Buffer.from([0, 1, 2, 3]));
    chmodSync(path.join(at, 'run.sh'), 0o755);
    g(at, 'add', '-A');
    commit(at, made.env, 'work');
    const tip = g(at, 'rev-parse', 'HEAD');
    write(at, 'a.txt', 'a, staged\n');
    g(at, 'add', 'a.txt');
    write(at, 'b.txt', 'b, unstaged\n');
    write(at, 'fresh.txt', 'fresh\n');
    symlinkSync('a.txt', path.join(at, 'fresh-link'));
    write(at, 'debug.log', 'ignored\n');
    // Your branch moved on since: the comparison stays the base the worktree was made from.
    const main = work(made.app, { 'later.txt': 'later\n' });
    // The repository's own diff preferences change neither the order nor the patches' form.
    writeFileSync(path.join(made.root, 'order'), 'run.sh\nnew.txt\n');
    g(made.app, 'config', 'diff.orderFile', path.join(made.root, 'order'));
    g(made.app, 'config', 'diff.noprefix', 'true');
    g(made.app, 'config', 'color.ui', 'always');
    const before = listing(made.app);

    const result = value(await page());
    expect(listing(made.app)).toEqual(before);
    expect(BranchDiffOutput.safeParse(result).success).toBe(true);
    expect(bytes(result)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    const inventory = await inventoryUncommitted(made.git, {
      cwd: at,
      tip,
      drivers: [],
      copied: [],
    });
    if (!inventory.ok) throw new Error('No inventory.');
    expect(result).toMatchObject({
      agent: 'builder',
      workspace: tree.id,
      shared: ['builder'],
      source: { ref: tree.branchRef, oid: tip, onBranch: true },
      base: { ref: 'refs/heads/main', oid: made.base },
      into: { ref: 'refs/heads/main', oid: main },
      committed: { files: 7, complete: true },
      uncommitted: {
        changed: 2,
        untracked: 2,
        partlyStaged: 0,
        complete: true,
        digest: inventory.value.digest,
      },
      next: null,
    });
    expect(result.uncommitted.digest).toMatch(/^[0-9a-f]{64}$/);
    // Committed first, in Git's order for `diff -M`; then uncommitted, by path.
    expect(result.files.map((file) => [file.section, file.path, file.status])).toEqual([
      ['committed', 'README.md', 'modified'],
      ['committed', 'blob.bin', 'added'],
      ['committed', 'gone.txt', 'deleted'],
      ['committed', 'link', 'added'],
      ['committed', 'moved.txt', 'renamed'],
      ['committed', 'new.txt', 'added'],
      ['committed', 'run.sh', 'modified'],
      ['uncommitted', 'a.txt', 'modified'],
      ['uncommitted', 'b.txt', 'modified'],
      ['uncommitted', 'fresh-link', 'untracked'],
      ['uncommitted', 'fresh.txt', 'untracked'],
    ]);
    const committed = byPath(result.files, 'committed');
    expect(committed.get('README.md')?.patch).toMatch(/^diff --git a\/README\.md b\/README\.md\n/);
    expect(committed.get('README.md')?.patch).toMatch(/^\+world$/m);
    expect(committed.get('gone.txt')?.patch).toMatch(/^-gone$/m);
    expect(committed.get('moved.txt')).toMatchObject({ oldPath: 'old.txt' });
    expect(committed.get('moved.txt')?.patch).toMatch(/^rename from old\.txt$/m);
    expect(committed.get('link')).toMatchObject({
      note: 'symlink',
      mode: { old: null, new: '120000' },
    });
    expect(committed.get('link')?.patch).toMatch(/^\+README\.md$/m);
    expect(committed.get('blob.bin')).toMatchObject({ binary: true });
    expect(committed.get('blob.bin')?.patch).toBeUndefined();
    expect(committed.get('run.sh')).toMatchObject({ mode: { old: '100644', new: '100755' } });
    const uncommitted = byPath(result.files, 'uncommitted');
    expect(uncommitted.get('a.txt')).toMatchObject({ staged: true });
    expect(uncommitted.get('a.txt')?.patch).toMatch(/^\+a, staged$/m);
    expect(uncommitted.get('b.txt')).toMatchObject({ staged: false });
    expect(uncommitted.get('b.txt')?.patch).toMatch(/^\+b, unstaged$/m);
    expect(uncommitted.get('fresh.txt')?.patch).toBe(
      untrackedFilePatch('fresh.txt', Buffer.from('fresh\n')).patch,
    );
    expect(uncommitted.get('fresh-link')).toMatchObject({ note: 'symlink' });
    expect(uncommitted.get('fresh-link')?.patch).toMatch(/^new file mode 120000$/m);
    expect(uncommitted.get('fresh-link')?.patch).toMatch(/^\+a\.txt$/m);
    expect(uncommitted.has('debug.log')).toBe(false);
  });

  it('pages committed then uncommitted entries, each once, within the budget, a long patch cut at a line', async () => {
    const tree = await bound();
    const at = tree.path;
    const files: Record<string, string> = {};
    for (let n = 0; n < 6; n++) files[`c${String(n)}.txt`] = `c${String(n)}\n`;
    files['huge.txt'] = Array.from({ length: 20_000 }, (_, n) => `line ${String(n)}`).join('\n');
    work(at, files);
    for (let n = 0; n < 3; n++) write(at, `u${String(n)}.txt`, `u${String(n)}\n`);

    const all = await pages(3);
    expect(all.length).toBeGreaterThan(3);
    for (const one of all) {
      expect(bytes(one)).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(BranchDiffOutput.safeParse(one).success).toBe(true);
      expect(one.files.length).toBeGreaterThan(0);
      expect(one.files.length).toBeLessThanOrEqual(3);
    }
    const seen = all.flatMap((one) => one.files);
    expect(seen.map((file) => file.path)).toEqual([
      'c0.txt',
      'c1.txt',
      'c2.txt',
      'c3.txt',
      'c4.txt',
      'c5.txt',
      'huge.txt',
      'u0.txt',
      'u1.txt',
      'u2.txt',
    ]);
    const huge = seen.find((file) => file.path === 'huge.txt');
    expect(huge).toMatchObject({ cut: true });
    expect(huge?.patch?.endsWith('\n')).toBe(true);
    expect(huge?.patch).toMatch(/^\+line 0$/m);
    expect(huge?.patch).not.toMatch(/^\+line 19999$/m);
  });

  it('refuses a continuation once the work changed: a new commit, other uncommitted work, even where no commit is offered', async () => {
    const tree = await bound();
    const at = tree.path;
    work(at, { 'one.txt': '1\n', 'two.txt': '2\n' });
    const first = value(await page({ limit: 1 }));
    const after = first.next ?? undefined;
    expect(after).toBeDefined();
    // Unchanged, it continues.
    expect(value(await page({ limit: 1, after })).files[0]?.path).toBe('two.txt');
    // A new commit moves the tip.
    work(at, { 'three.txt': '3\n' });
    expect(await page({ limit: 1, after })).toMatchObject({
      ok: false,
      error: { code: 'conflict', sentence: expect.stringContaining('Builder') as unknown },
    });
    // Other uncommitted work, with a digest.
    write(at, 'a.txt', 'a, edited\n');
    const dirty = value(await page({ limit: 1 }));
    expect(dirty.uncommitted.digest).not.toBeNull();
    write(at, 'a.txt', 'a, edited again\n');
    expect(await page({ limit: 1, after: dirty.next ?? undefined })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    // Partly staged, so no digest: still another state, still refused.
    write(at, 'b.txt', 'b, staged\n');
    g(at, 'add', 'b.txt');
    write(at, 'b.txt', 'b, staged, then more\n');
    const partly = value(await page({ limit: 1 }));
    expect(partly.uncommitted).toMatchObject({ partlyStaged: 1, digest: null });
    write(at, 'a.txt', 'a, edited a third time\n');
    expect(await page({ limit: 1, after: partly.next ?? undefined })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    // Not a cursor at all.
    expect(await page({ after: 'AAAA' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    for (const limit of [0, 201, 1.5]) {
      expect(await page({ limit })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    }
  });

  it('never splices a change made while a page is read: the first page is read again, a later one refused', async () => {
    const racing = new Racing(made.runnerDeps);
    const tree = await bound();
    const at = tree.path;
    work(at, { 'one.txt': '1\n' });
    write(at, 'a.txt', 'a, first\n');
    racing.race = () => {
      write(at, 'a.txt', 'a, second\n');
    };
    const first = value(await page({}, { git: racing }));
    expect(racing.race).toBeUndefined();
    const shown = byPath(first.files, 'uncommitted').get('a.txt');
    expect(shown?.patch).toMatch(/^\+a, second$/m);
    const tip = g(at, 'rev-parse', 'HEAD');
    const now = await inventoryUncommitted(made.git, { cwd: at, tip, drivers: [], copied: [] });
    expect(now.ok && now.value.digest).toBe(first.uncommitted.digest);

    const start = value(await page({ limit: 1 }, { git: racing }));
    racing.race = () => {
      write(at, 'a.txt', 'a, third\n');
    };
    expect(await page({ limit: 1, after: start.next ?? undefined }, { git: racing })).toMatchObject(
      { ok: false, error: { code: 'conflict' } },
    );
  });

  it('reads untracked files itself: never through a link, a second name or past its bound', async () => {
    const tree = await bound();
    const at = tree.path;
    const secret = path.join(made.root, 'secret.txt');
    writeFileSync(secret, 'SECRET\n');
    symlinkSync(secret, path.join(at, 'peek'));
    linkSync(secret, path.join(at, 'hard.txt'));
    write(at, 'big.txt', 'x\n'.repeat(1024 * 1024));
    write(at, 'bin.dat', Buffer.from([65, 0, 66]));
    write(at, 'tool.sh', '#!/bin/sh\n');
    chmodSync(path.join(at, 'tool.sh'), 0o755);
    // Swapped for a link while the page is read (as a.txt's patch is), before the core reads it:
    // never read through it.
    write(at, 'b-swap.txt', 'swap\n');
    write(at, 'a.txt', 'a, edited\n');
    const racing = new Racing(made.runnerDeps);
    racing.race = () => {
      rmSync(path.join(at, 'b-swap.txt'));
      symlinkSync(secret, path.join(at, 'b-swap.txt'));
    };
    const all = await pages(200, {});
    const swapped = value(await page({}, { git: racing }));
    for (const one of [...all, swapped]) expect(JSON.stringify(one)).not.toContain('SECRET');
    const files = byPath(
      all.flatMap((one) => one.files),
      'uncommitted',
    );
    expect(files.get('peek')).toMatchObject({ note: 'symlink' });
    expect(files.get('peek')?.patch).toContain(`+${secret}`);
    expect(files.get('hard.txt')).toMatchObject({ note: 'unreadable' });
    expect(files.get('hard.txt')?.patch).toBeUndefined();
    expect(files.get('big.txt')).toMatchObject({ cut: true });
    expect(files.get('bin.dat')).toMatchObject({ binary: true });
    expect(files.get('bin.dat')?.patch).toBeUndefined();
    expect(files.get('tool.sh')?.patch).toMatch(/^new file mode 100755$/m);
    expect(racing.race).toBeUndefined();
    expect(byPath(swapped.files, 'uncommitted').get('b-swap.txt')).toMatchObject({
      note: 'symlink',
    });
    // What the review can't show, a checkpoint doesn't commit.
    expect(swapped.uncommitted.digest).toBeNull();
  });

  it('runs no program a repository configures, reading committed or uncommitted work', async () => {
    const sentinel = path.join(made.root, 'ran');
    const program = sentinelProgram(made.root, sentinel);
    const tree = await bound();
    const at = tree.path;
    // A submodule with programs of its own, whose changes .gitmodules asks to be looked at.
    const sub = path.join(made.root, 'sub');
    mkdirSync(sub);
    g(sub, 'init', '-q', '-b', 'main');
    write(sub, 's.txt', 'aaa\n');
    write(sub, '.gitattributes', '*.txt filter=inner\n');
    g(sub, 'add', '-A');
    commit(sub, made.env, 'sub');
    g(at, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
    g(at, 'config', '-f', '.gitmodules', 'submodule.sub.ignore', 'none');
    write(at, '.gitattributes', '*.txt filter=sent diff=sent\n');
    write(at, 'a.txt', 'a, committed\n');
    g(at, 'add', '-A');
    commit(at, made.env, 'work');
    // Then every program the repository can name, the agent's worktree included.
    for (const key of ['clean', 'smudge', 'process']) {
      g(made.app, 'config', `filter.sent.${key}`, `${program} filter-${key}`);
    }
    g(made.app, 'config', 'filter.sent.required', 'true');
    g(made.app, 'config', 'diff.external', `${program} external`);
    g(made.app, 'config', 'diff.sent.textconv', `${program} textconv`);
    g(made.app, 'config', 'diff.sent.command', `${program} command`);
    g(made.app, 'config', 'diff.submodule', 'diff');
    g(made.app, 'config', 'core.fsmonitor', `${program} fsmonitor`);
    g(made.app, 'config', 'gpg.program', `${program} gpg`);
    g(made.app, 'config', 'log.showSignature', 'true');
    hooksInto(path.join(made.root, 'hooks-elsewhere'), program);
    hooksInto(path.join(made.app, '.git', 'hooks'), program);
    g(made.app, 'config', 'core.hooksPath', path.join(made.root, 'hooks-elsewhere'));
    g(path.join(at, 'sub'), 'config', 'filter.inner.clean', `${program} inner`);
    g(path.join(at, 'sub'), 'config', 'diff.external', `${program} inner-external`);
    write(path.join(at, 'sub'), 's.txt', 'bbb\n');
    write(at, 'a.txt', 'a, uncommitted\n');
    write(at, 'new.txt', 'new\n');
    // The control: Git runs the repository's programs when nothing stops it (the process filter,
    // whose protocol the sentinel doesn't speak, aside; what fails isn't required).
    writeFileSync(sentinel, '');
    g(at, '-c', 'filter.sent.process=', '-c', 'filter.sent.required=false', 'diff', 'HEAD');
    const control = ran(sentinel).join('\n');
    for (const program of ['fsmonitor', 'inner', 'command']) {
      expect(control).toContain(program);
    }
    writeFileSync(sentinel, '');

    const all = await pages(2);
    expect(ran(sentinel)).toEqual([]);
    const seen = all.flatMap((one) => one.files);
    expect(seen.find((file) => file.section === 'committed' && file.path === 'sub')).toMatchObject({
      note: 'gitlink',
    });
    expect(
      seen.find((file) => file.section === 'uncommitted' && file.path === 'a.txt')?.patch,
    ).toMatch(/^\+a, uncommitted$/m);
  });

  it('reads, makes and repairs nothing: no worktree yet, or one gone, is unavailable and stays so', async () => {
    const before = listing(made.app);
    expect(await page()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(existsSync(path.join(made.app, '.corral'))).toBe(false);
    expect(listing(made.app)).toEqual(before);

    const tree = await bound();
    rmSync(tree.path, { recursive: true, force: true });
    const gone = await page();
    expect(gone).toMatchObject({
      ok: false,
      error: { code: 'unavailable', sentence: 'Builder’s worktree is missing.' },
    });
    expect(existsSync(tree.path)).toBe(false);
    expect(made.workspaces.worktree(tree.id)?.state).toBe('ready');
  });

  it('reviews the active tree while a change waits for your Switch, and an agent off its branch without its uncommitted work', async () => {
    const tree = await bound();
    const at = tree.path;
    const tip = work(at, { 'one.txt': '1\n' });
    write(at, 'a.txt', 'a, edited\n');
    await made.workspaces.write((w) => {
      w.plan(CANVAS, 'builder', 'agent/elsewhere');
    });
    const waiting = value(await page());
    expect(waiting).toMatchObject({ workspace: tree.id, source: { oid: tip, onBranch: true } });
    expect(waiting.files.map((file) => file.path)).toEqual(['one.txt', 'a.txt']);

    g(at, 'checkout', '-q', '-b', 'other');
    work(at, { 'two.txt': '2\n' });
    const off = value(await page());
    expect(off).toMatchObject({
      source: { ref: tree.branchRef, oid: tip, onBranch: false },
      committed: { files: 1, complete: true },
      uncommitted: { changed: 0, untracked: 0, partlyStaged: 0, complete: false, digest: null },
    });
    expect(off.files.map((file) => [file.section, file.path])).toEqual([['committed', 'one.txt']]);
  });

  it('shows a shared tree’s one branch, naming only the members the caller reaches', async () => {
    const tree = await bound('group/lead', ['lead', 'helper']);
    work(tree.path, { 'team.txt': 'team\n' });
    const yours = value(await page({ agent: 'helper' }));
    expect(yours).toMatchObject({ workspace: tree.id, shared: ['helper', 'lead'] });
    const token = value(
      await page({ agent: 'lead', viewer: { kind: 'token', reached: new Set(['lead']) } }),
    );
    expect(token).toMatchObject({ workspace: tree.id, shared: ['lead'] });
    expect(token.files.map((file) => file.path)).toEqual(['team.txt']);
  });

  it('shows a name that isn’t UTF-8, or is too long, lossy and without a patch', async () => {
    const tree = await bound();
    const at = tree.path;
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: at,
      env: made.env,
      input: 'odd\n',
    })
      .toString()
      .trim();
    const names = [
      Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff]), Buffer.from('.txt')]),
      Buffer.from('x'.repeat(5000)),
    ];
    execFileSync('git', ['update-index', '--add', '-z', '--index-info'], {
      cwd: at,
      env: made.env,
      input: Buffer.concat(
        names.map((name) =>
          Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0])]),
        ),
      ),
    });
    commit(at, made.env, 'odd names');
    const files = (await pages(200)).flatMap((one) => one.files);
    const committed = files.filter((file) => file.section === 'committed');
    expect(committed).toHaveLength(2);
    for (const file of committed) {
      expect(file).toMatchObject({ note: 'lossy-name' });
      expect(file.patch).toBeUndefined();
      expect(Buffer.byteLength(file.path)).toBeLessThanOrEqual(4096);
    }
    expect(committed.some((file) => file.path.includes(REPLACEMENT))).toBe(true);
  });

  it('takes every name as itself: a name that looks like a pathspec is that file alone', async () => {
    const tree = await bound();
    work(tree.path, { '*': 'star\n', '[ab]': 'brackets\n', ab: 'ab\n', a: 'aaa\n' });
    const files = byPath(value(await page()).files, 'committed');
    expect(files.get('*')?.patch).toMatch(/^\+star$/m);
    expect(files.get('*')?.patch).not.toMatch(/aaa|brackets/);
    expect(files.get('[ab]')?.patch).toMatch(/^\+brackets$/m);
    expect(files.get('[ab]')?.patch).not.toMatch(/aaa/);
  });

  it('reviews the commits themselves, whatever replace refs say', async () => {
    const tree = await bound();
    const at = tree.path;
    const tip = work(at, { 'real.txt': 'real\n' });
    const decoy = g(
      at,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit-tree',
      '-p',
      made.base,
      '-m',
      'decoy',
      g(made.app, 'rev-parse', `${made.base}^{tree}`),
    );
    g(at, 'replace', tip, decoy);
    const result = value(await page());
    expect(result.files.map((file) => file.path)).toEqual(['real.txt']);
  });

  it('counts past 10,000 committed files without listing them, incomplete', async () => {
    const tree = await bound();
    const at = tree.path;
    mkdirSync(path.join(at, 'many'));
    for (let n = 0; n <= 10_000; n++) writeFileSync(path.join(at, 'many', String(n)), '');
    g(at, 'add', '-A');
    commit(at, made.env, 'many');
    const first = value(await page({ limit: 200 }));
    expect(first.committed).toEqual({ files: 10_001, complete: false });
    expect(first.files).toHaveLength(200);
    expect(first.next).not.toBeNull();
  });

  it('is unavailable when the recorded base commit is gone, never an empty list', async () => {
    const tree = await bound();
    work(tree.path, { 'one.txt': '1\n' });
    const object = path.join(
      made.app,
      '.git',
      'objects',
      made.base.slice(0, 2),
      made.base.slice(2),
    );
    expect(existsSync(object)).toBe(true);
    chmodSync(object, 0o600);
    rmSync(object);
    expect(await page()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('says where your checkout is now, detached included, without merging anything', async () => {
    const tree = await bound();
    work(tree.path, { 'one.txt': '1\n' });
    g(made.app, 'checkout', '-q', '--detach');
    expect(value(await page()).into).toEqual({ ref: null, oid: made.base });
    expect(value(await page({}, { projectRoot: () => undefined })).into).toEqual({
      ref: null,
      oid: null,
    });
  });

  it('shows a changed tracked file with another link unreadable, without its patch, and offers no commit', async () => {
    const tree = await bound();
    const at = tree.path;
    write(at, 'a.txt', 'a, edited\n');
    write(at, 'b.txt', 'b, edited\n');
    expect(value(await page()).uncommitted.digest).not.toBeNull();
    linkSync(path.join(at, 'a.txt'), path.join(made.root, 'a-second-name.txt'));
    const result = value(await page());
    expect(result.uncommitted.digest).toBeNull();
    const files = byPath(result.files, 'uncommitted');
    expect(files.get('a.txt')).toMatchObject({ status: 'modified', note: 'unreadable' });
    expect(files.get('a.txt')?.patch).toBeUndefined();
    expect(files.get('b.txt')?.patch).toMatch(/^\+b, edited$/m);
    // An unchanged one has no entry, and still no commit is offered.
    rmSync(path.join(made.root, 'a-second-name.txt'));
    linkSync(path.join(at, 'gone.txt'), path.join(made.root, 'gone-second-name.txt'));
    const unchanged = value(await page());
    expect(unchanged.uncommitted.digest).toBeNull();
    expect(unchanged.files.map((file) => [file.path, file.note])).toEqual([
      ['a.txt', undefined],
      ['b.txt', undefined],
    ]);
  });

  it('marks what Git couldn’t read, never leaving it out', async () => {
    const tree = await bound();
    const at = tree.path;
    work(at, { 'lost.txt': 'lost blob\n', 'kept.txt': 'kept\n' });
    const blob = g(at, 'rev-parse', 'HEAD:lost.txt');
    rmSync(path.join(made.app, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const files = byPath(value(await page()).files, 'committed');
    expect(files.get('lost.txt')).toMatchObject({ note: 'unreadable' });
    expect(files.get('lost.txt')?.patch).toBeUndefined();
    expect(files.get('kept.txt')?.patch).toMatch(/^\+kept$/m);
    expect(readFileSync(path.join(at, 'lost.txt'), 'utf8')).toBe('lost blob\n');
  });
});

describe.skipIf(process.platform === 'win32' || !gitInits('--object-format=sha256'))(
  'Review changes in a SHA-256 repository',
  () => {
    it('lists and pages its work by its own object ids', async () => {
      await made.close();
      made = await testWorkspaces({ 'README.md': 'hello\n' }, {}, ['--object-format=sha256']);
      const tree = await bound();
      const tip = work(tree.path, { 'one.txt': '1\n', 'two.txt': '2\n' });
      write(tree.path, 'README.md', 'changed\n');
      expect(tip).toHaveLength(64);
      const all = await pages(1);
      expect(all[0]).toMatchObject({
        source: { oid: tip },
        base: { oid: made.base },
        into: { oid: made.base },
        committed: { files: 2, complete: true },
        uncommitted: { changed: 1, complete: true },
      });
      expect(all[0]?.uncommitted.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(all.flatMap((one) => one.files.map((file) => file.path))).toEqual([
        'one.txt',
        'two.txt',
        'README.md',
      ]);
      expect(all[2]?.files[0]?.patch).toMatch(/^\+changed$/m);
    });
  },
);
