import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { newCanvasId } from '../../../shared/canvas';
import { CanvasMemory } from '../../memory';
import { mintTrustedPath } from '../host';
import type { Store } from '../store/store';
import { openTestStore } from '../store/test-store';
import { gitReads, MergeObserver } from './observe';
import type { MergeObserverDeps, ObserverReads, WorkspaceRead } from './observe';
import { WorkspaceStore } from './store';
import { differing, gitInits, hooksInto, listing, ran, sentinelProgram } from './test-git';
import { mergeWorld, put } from './test-merge';
import type { MergeWorld } from './test-merge';
import { CANVAS } from './test-workspace';
import { inventoryUncommitted } from './uncommitted';

/*
 * B9b's merge state as each agent's card shows it (Design §9 C12): an observation service in the
 * core, never the list selector. Per workspace its branch's tip, whether that tip is in the history
 * of the branch your picked checkout is on now, and how much is uncommitted in its tree; per canvas
 * your picked checkout's branch and commit. Read only when asked (a merge settling, a review, a
 * turn's end or a session's close, a window's focus), coalesced to one pass per repository every 2
 * seconds, at most 64 workspaces a pass, each a few read-only Git calls that take no lock and run
 * no program a repository configures. Reading what it found asks Git nothing. Real Git, throwaway
 * repositories, for what it reads; fake reads for when.
 */

vi.setConfig({ testTimeout: 60_000 });

const SHA256 = gitInits('--object-format=sha256');

let world: MergeWorld | undefined;
let observer: MergeObserver | undefined;
afterEach(async () => {
  observer?.close();
  observer = undefined;
  await world?.service.drained();
  await world?.close();
  world = undefined;
});

async function make(options: Parameters<typeof mergeWorld>[0] = {}): Promise<MergeWorld> {
  world = await mergeWorld(options);
  return world;
}

/** The observation over a world's records, your picked checkout and its Git. */
function observing(
  w: MergeWorld,
  changes: Partial<MergeObserverDeps> = {},
): { observer: MergeObserver; changed: ReturnType<typeof vi.fn<(canvas: CanvasId) => void>> } {
  const changed = vi.fn<(canvas: CanvasId) => void>();
  observer = new MergeObserver({
    workspaces: w.workspaces,
    projectRoot: () => mintTrustedPath(w.picked),
    reads: gitReads(w.git),
    changed,
    ...changes,
  });
  return { observer, changed };
}

/** The agent's branch merged into main as you would, with your own Git. */
function mergedByYou(w: MergeWorld): string {
  w.g(w.picked, 'merge', '--no-ff', '-q', '-m', 'yours', w.tree.branchRef);
  return w.g(w.picked, 'rev-parse', 'HEAD');
}

describe.skipIf(process.platform === 'win32')('what it reads', () => {
  it('reads your checkout and an agent’s tree when asked, and asks Git nothing to say what it read', async () => {
    const w = await make();
    const { observer: o } = observing(w);
    const runs = vi.spyOn(w.git, 'run');
    const inspects = vi.spyOn(w.git, 'inspect');
    expect(o.into(CANVAS)).toBeNull();
    expect(o.of(w.tree.id)).toEqual({ merged: null, uncommitted: null });
    expect(runs).not.toHaveBeenCalled();

    await o.now(CANVAS, w.tree.id);
    const asked = runs.mock.calls.length + inspects.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      expect(o.into(CANVAS)).toEqual({
        ref: 'refs/heads/main',
        oid: w.g(w.picked, 'rev-parse', 'HEAD'),
      });
      o.of(w.tree.id);
    }
    expect(runs.mock.calls.length + inspects.mock.calls.length).toBe(asked);
  });

  it('calls a branch with no commits of its own beyond its base no merge of anything', async () => {
    const w = await make();
    const { observer: o } = observing(w);
    await o.now(CANVAS, w.tree.id);
    // Its tip is its base, which is in main's history: nothing of its own is merged, or not.
    expect(o.of(w.tree.id)).toEqual({ merged: null, uncommitted: 0 });
  });

  it('says its commits are merged once they are in your branch’s history, by any merge, and not before', async () => {
    const w = await make();
    const { observer: o } = observing(w);
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: false, uncommitted: 0 });

    const after = mergedByYou(w);
    await o.now(CANVAS, w.tree.id);
    expect(o.into(CANVAS)).toEqual({ ref: 'refs/heads/main', oid: after });
    expect(o.of(w.tree.id)).toEqual({ merged: true, uncommitted: 0 });

    // A new commit on its branch: not merged until it is.
    w.work(w.cwd, { 'more.txt': 'more\n' });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: false, uncommitted: 0 });
  });

  it('reads ancestry from the commits themselves when grafts name other parents', async () => {
    const w = await make();
    const tip = w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const base = w.work(w.picked, { 'yours.txt': 'yours\n' });
    const info = path.join(w.record.commonDir, 'info');
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, 'grafts'), `${base} ${tip}\n`);
    // Replace-object suppression alone still lets ordinary Git read these other parents.
    expect(w.g(w.picked, '--no-replace-objects', 'merge-base', '--is-ancestor', tip, base)).toBe(
      '',
    );
    const { observer: o } = observing(w);
    await o.now(CANVAS, w.tree.id);
    expect(o.into(CANVAS)).toEqual({ ref: 'refs/heads/main', oid: base });
    expect(o.of(w.tree.id).merged).toBe(false);
  });

  it('leaves a branch unknown if its tip moves while its merge state is read', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    mergedByYou(w);
    const { observer: o } = observing(w);
    const run = w.git.run.bind(w.git);
    let moved = false;
    vi.spyOn(w.git, 'run').mockImplementation(async (call) => {
      const result = await run(call);
      if (!moved && call.args.includes('merge-base')) {
        moved = true;
        w.work(w.cwd, { 'next.txt': 'next\n' });
      }
      return result;
    });
    await o.now(CANVAS, w.tree.id);
    expect(moved).toBe(true);
    expect(o.of(w.tree.id)).toEqual({ merged: null, uncommitted: null });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: false, uncommitted: 0 });
  });

  it('leaves a checkout unknown if it changes branch while its merge state is read', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    mergedByYou(w);
    const { observer: o } = observing(w);
    const run = w.git.run.bind(w.git);
    let moved = false;
    vi.spyOn(w.git, 'run').mockImplementation(async (call) => {
      const result = await run(call);
      if (!moved && call.args.includes('status')) {
        moved = true;
        w.g(w.cwd, 'switch', '-q', '--detach');
      }
      return result;
    });
    await o.now(CANVAS, w.tree.id);
    expect(moved).toBe(true);
    expect(o.of(w.tree.id)).toEqual({ merged: null, uncommitted: null });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: true, uncommitted: null });
  });

  it('counts uncommitted work as Review changes counts it: changed, staged or not, and untracked', async () => {
    const w = await make({
      files: { 'README.md': 'hello\n', 'gone.txt': 'gone\n', '.gitignore': 'build/\n' },
    });
    const { observer: o } = observing(w);
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    put(w.cwd, 'README.md', 'edited\n');
    put(w.cwd, 'staged.txt', 'staged\n');
    w.g(w.cwd, 'add', 'staged.txt');
    put(w.cwd, 'new/untracked.txt', 'new\n');
    put(w.cwd, 'build/ignored.log', 'ignored\n');
    rmSync(path.join(w.cwd, 'gone.txt'));
    const review = await inventoryUncommitted(w.git, {
      cwd: w.cwd,
      tip: w.g(w.cwd, 'rev-parse', 'HEAD'),
      drivers: [],
      copied: [],
    });
    if (!review.ok) throw new Error(JSON.stringify(review.refusal));

    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: false, uncommitted: 4 });
    expect(review.value.changed + review.value.untracked).toBe(4);
  });

  it('says nothing of uncommitted work in a tree off its branch, still its branch’s commits', async () => {
    const w = await make();
    const { observer: o } = observing(w);
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    mergedByYou(w);
    w.g(w.cwd, 'switch', '-q', '--detach');
    put(w.cwd, 'draft.txt', 'draft\n');
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: true, uncommitted: null });
  });

  it('reads your checkout as Review changes does, and says merged against the branch it is on now', async () => {
    const w = await make();
    const { observer: o } = observing(w);
    w.g(w.picked, 'branch', 'older');
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    mergedByYou(w);
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toMatchObject({ merged: true });

    // Your checkout switched to a branch without its commits: re-labelled against that one.
    w.g(w.picked, 'switch', '-q', 'older');
    await o.now(CANVAS, w.tree.id);
    expect(o.into(CANVAS)).toEqual({
      ref: 'refs/heads/older',
      oid: w.g(w.picked, 'rev-parse', 'HEAD'),
    });
    expect(o.of(w.tree.id)).toMatchObject({ merged: false });

    // Detached: no branch, its commit.
    w.g(w.picked, 'switch', '-q', '--detach', 'main');
    await o.now(CANVAS, w.tree.id);
    expect(o.into(CANVAS)).toEqual({ ref: null, oid: w.g(w.picked, 'rev-parse', 'HEAD') });
    expect(o.of(w.tree.id)).toMatchObject({ merged: true });
  });

  it('never says merged against a commit of yours it wasn’t read against', async () => {
    const w = await make();
    const { observer: o, changed } = observing(w);
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    mergedByYou(w);
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: true, uncommitted: 0 });
    expect(changed).toHaveBeenCalledWith(CANVAS);

    // Your branch moved, and only your checkout was read again: the old answer isn't shown.
    w.work(w.picked, { 'yours.txt': 'yours\n' });
    changed.mockClear();
    await o.now(CANVAS);
    expect(changed).toHaveBeenCalledWith(CANVAS);
    expect(o.of(w.tree.id)).toEqual({ merged: null, uncommitted: 0 });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: true, uncommitted: 0 });
  });

  it('says nothing of a tree that isn’t the one made, or is gone', async () => {
    const w = await make();
    const { observer: o } = observing(w);
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: false, uncommitted: 0 });
    rmSync(w.cwd, { recursive: true, force: true });
    await o.now(CANVAS, w.tree.id);
    expect(o.of(w.tree.id)).toEqual({ merged: null, uncommitted: null });
  });

  it('reads a linked picked checkout by its own HEAD', async () => {
    const w = await make({ linked: 'side' });
    const { observer: o } = observing(w);
    await o.now(CANVAS, w.tree.id);
    expect(o.into(CANVAS)).toEqual({
      ref: 'refs/heads/side',
      oid: w.g(w.picked, 'rev-parse', 'HEAD'),
    });
  });

  it.skipIf(!SHA256)('reads a SHA-256 repository', async () => {
    const w = await make({ init: ['--object-format=sha256'] });
    const { observer: o } = observing(w);
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    mergedByYou(w);
    await o.now(CANVAS, w.tree.id);
    expect(o.into(CANVAS)?.oid).toMatch(/^[0-9a-f]{64}$/);
    expect(o.of(w.tree.id)).toEqual({ merged: true, uncommitted: 0 });
  });

  it('writes nothing and runs none of a hostile repository’s programs, where plain Git would', async () => {
    const w = await make();
    const sentinel = path.join(w.root, 'ran');
    const program = sentinelProgram(w.root, sentinel);
    w.work(w.cwd, { 'agent.txt': 'agent\n', 'filtered.txt': 'filtered\n' });
    // Then every program the repository can name, the agent's tree included.
    hooksInto(path.join(w.app, '.git', 'hooks'), program);
    hooksInto(path.join(w.root, 'hooks-elsewhere'), program);
    w.g(w.app, 'config', 'core.hooksPath', path.join(w.root, 'hooks-elsewhere'));
    for (const key of ['clean', 'smudge']) {
      w.g(w.app, 'config', `filter.sent.${key}`, `${program} filter-${key}`);
    }
    w.g(w.app, 'config', 'core.fsmonitor', `${program} fsmonitor`);
    w.g(w.app, 'config', 'diff.external', `${program} external`);
    w.g(w.app, 'config', 'core.editor', `${program} editor`);
    writeFileSync(path.join(w.app, '.git', 'info', 'attributes'), '* filter=sent\n');
    // A file whose stat changed (Git reads it to compare: through a clean filter, if it ran one),
    // an edit, and a new file.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(w.cwd, 'filtered.txt'), old, old);
    put(w.cwd, 'README.md', 'edited\n');
    put(w.cwd, 'new.txt', 'new\n');
    const gitDirs = () => ({
      ...listing(path.join(w.app, '.git'), (at) => at === 'objects'),
      ...Object.fromEntries(
        Object.entries(listing(w.cwd)).map(([at, what]) => [`tree/${at}`, what]),
      ),
    });
    const before = gitDirs();
    writeFileSync(sentinel, '');
    const { observer: o } = observing(w);

    await o.now(CANVAS, w.tree.id);

    expect(o.of(w.tree.id)).toEqual({ merged: false, uncommitted: 2 });
    expect(ran(sentinel)).toEqual([]);
    expect(differing(before, gitDirs())).toEqual([]);

    // The control: plain Git, as the user's own status runs it there, runs them and rewrites the
    // index.
    w.g(w.cwd, 'status', '--porcelain');
    const control = ran(sentinel).join('\n');
    for (const one of ['fsmonitor', 'filter-clean']) expect(control).toContain(one);
    expect(differing(before, gitDirs())).not.toEqual([]);
  });
});

describe('when it reads', () => {
  const REPOSITORIES = [
    '22222222-2222-4222-8222-222222222221',
    '22222222-2222-4222-8222-222222222222',
  ];
  const OID = (n: number) => n.toString(16).padStart(40, '0');
  let folder: string;
  let store: Store;
  let workspaces: WorkspaceStore;
  let canvas: CanvasId;
  let other: CanvasId;

  /** `count` ready workspaces of a repository on a canvas, each its agent's: their ids. */
  async function trees(on: CanvasId, repository: string, count: number): Promise<string[]> {
    return workspaces.write((w) => {
      if (w.repository(repository) === undefined) {
        w.addRepository({
          id: repository,
          pickedRoot: `/picked/${repository}`,
          realRoot: `/picked/${repository}`,
          commonDir: `/picked/${repository}/.git`,
          identity: repository,
          rootKind: 'project',
          ownedRoot: `/picked/${repository}/.corral/worktrees/profile`,
        });
      }
      w.bindCanvas(on, repository);
      return Array.from({ length: count }, (_, at) => {
        const id = crypto.randomUUID();
        w.createWorktree({
          id,
          canvas: on,
          repository,
          owner: `agent/a${String(at)}`,
          path: `/picked/${repository}/.corral/worktrees/profile/${id}`,
          branchRef: `refs/heads/corrallm/profile/${id}`,
          baseCheckout: `/picked/${repository}`,
          baseRef: 'refs/heads/main',
          baseOid: OID(1),
          forkedFrom: null,
        });
        w.transition(id, { from: 'creating', to: 'setup' });
        w.transition(id, { from: 'setup', to: 'ready' });
        w.bind(on, `a${String(at)}`, id);
        return id;
      });
    });
  }

  /** Reads that answer at once (or as a test says), each recorded. */
  function fakeReads(): ObserverReads & {
    workspace: ReturnType<typeof vi.fn<ObserverReads['workspace']>>;
    into: ReturnType<typeof vi.fn<ObserverReads['into']>>;
  } {
    return {
      into: vi.fn<ObserverReads['into']>(() =>
        Promise.resolve({ ref: 'refs/heads/main', oid: OID(2) }),
      ),
      workspace: vi.fn<ObserverReads['workspace']>((): Promise<WorkspaceRead> =>
        Promise.resolve({ tip: OID(3), merged: false, uncommitted: 0 }),
      ),
    };
  }

  function observe(reads: ObserverReads, changed = vi.fn<(canvas: CanvasId) => void>()) {
    observer = new MergeObserver({
      workspaces,
      projectRoot: (at) => mintTrustedPath(`/picked/${at}`),
      reads,
      changed,
    });
    return observer;
  }

  const readOf = (reads: ReturnType<typeof fakeReads>) =>
    reads.workspace.mock.calls.map(([, tree]) => tree.id);

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'corrallm-observe-'));
    store = await openTestStore(folder);
    canvas = newCanvasId();
    other = newCanvasId();
    await store.write(() => {
      const memory = new CanvasMemory(store);
      memory.ensure(canvas);
      memory.ensure(other);
    });
    workspaces = new WorkspaceStore({ store });
    // The store opened (it keeps time of its own), only the observer's timers are faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(async () => {
    observer?.close();
    observer = undefined;
    vi.useRealTimers();
    await store.close();
    await rm(folder, { recursive: true, force: true });
  });

  it('coalesces what asks into one pass per repository, at most every 2 seconds', async () => {
    const [one, two] = await trees(canvas, REPOSITORIES[0] ?? '', 2);
    const reads = fakeReads();
    const o = observe(reads);
    for (let i = 0; i < 5; i++) o.workspace(one ?? '');
    o.agent(canvas, 'a1');
    await vi.advanceTimersByTimeAsync(1999);
    expect(reads.workspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readOf(reads).sort()).toEqual([one, two].sort());
    expect(reads.into).toHaveBeenCalledTimes(1);

    // More, at once: the next pass two seconds on, never sooner.
    o.workspace(one ?? '');
    o.workspace(two ?? '');
    await vi.advanceTimersByTimeAsync(1999);
    expect(reads.workspace).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads.workspace).toHaveBeenCalledTimes(4);
    // Nothing asked: nothing read.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads.workspace).toHaveBeenCalledTimes(4);
  });

  it('coalesces requests during a slow pass into one later interval', async () => {
    const [one] = await trees(canvas, REPOSITORIES[0] ?? '', 1);
    const reads = fakeReads();
    const held = Promise.withResolvers<WorkspaceRead>();
    reads.workspace.mockReturnValueOnce(held.promise);
    const o = observe(reads);
    o.workspace(one ?? '');
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 0; i < 3; i++) {
      o.workspace(one ?? '');
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(reads.workspace).toHaveBeenCalledTimes(1);
    held.resolve({ tip: OID(3), merged: false, uncommitted: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.workspace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(reads.workspace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads.workspace).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads.workspace).toHaveBeenCalledTimes(2);
  });

  it('prunes observations of removed workspaces, including a read still finishing', async () => {
    const ids = await trees(canvas, REPOSITORIES[0] ?? '', 2);
    const [one = '', two = ''] = ids;
    const reads = fakeReads();
    const o = observe(reads);
    await o.now(canvas, one);
    const held = Promise.withResolvers<WorkspaceRead>();
    reads.workspace.mockReturnValueOnce(held.promise);
    const finishing = o.now(canvas, two);
    await vi.advanceTimersByTimeAsync(0);
    await workspaces.write((w) => {
      for (const [at, id] of ids.entries()) {
        w.unbind(canvas, `a${String(at)}`);
        w.transition(id, { from: 'ready', to: 'removing' });
        w.forget(id);
      }
    });
    expect(o.prune()).toBe(1);
    expect(o.prune()).toBe(0);
    held.resolve({ tip: OID(3), merged: true, uncommitted: 0 });
    await finishing;
    expect(o.prune()).toBe(0);
    expect(o.of(one)).toEqual({ merged: null, uncommitted: null });
    expect(o.of(two)).toEqual({ merged: null, uncommitted: null });
  });

  it('reads at most 64 workspaces a pass, the rest at the next', async () => {
    const ids = await trees(canvas, REPOSITORIES[0] ?? '', 70);
    const reads = fakeReads();
    const o = observe(reads);
    o.canvas(canvas);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads.workspace).toHaveBeenCalledTimes(64);
    await vi.advanceTimersByTimeAsync(2000);
    expect(new Set(readOf(reads))).toEqual(new Set(ids));
    expect(reads.workspace).toHaveBeenCalledTimes(70);
  });

  it('observes repositories apart: one slow never holds another’s', async () => {
    const [mine] = await trees(canvas, REPOSITORIES[0] ?? '', 1);
    const [theirs] = await trees(other, REPOSITORIES[1] ?? '', 1);
    const reads = fakeReads();
    const stuck = Promise.withResolvers<WorkspaceRead>();
    reads.workspace.mockImplementation((_repository, tree) =>
      tree.id === mine
        ? stuck.promise
        : Promise.resolve({ tip: OID(3), merged: true, uncommitted: 0 }),
    );
    const o = observe(reads);
    o.workspace(mine ?? '');
    o.workspace(theirs ?? '');
    await vi.advanceTimersByTimeAsync(2000);
    expect(o.of(theirs ?? '')).toEqual({ merged: true, uncommitted: 0 });
    stuck.resolve({ tip: OID(3), merged: false, uncommitted: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(o.of(mine ?? '')).toEqual({ merged: false, uncommitted: 1 });
  });

  it('reads what it is asked to now at once, after a pass going on, never two at a time', async () => {
    const [one, two] = await trees(canvas, REPOSITORIES[0] ?? '', 2);
    const reads = fakeReads();
    const going = Promise.withResolvers<WorkspaceRead>();
    let reading = 0;
    let most = 0;
    reads.workspace.mockImplementation(async (_repository, tree) => {
      reading++;
      most = Math.max(most, reading);
      try {
        return tree.id === one
          ? await going.promise
          : { tip: OID(3), merged: true, uncommitted: 2 };
      } finally {
        reading--;
      }
    });
    const o = observe(reads);
    o.workspace(one ?? '');
    await vi.advanceTimersByTimeAsync(2000);
    let done = false;
    const now = o.now(canvas, two).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    going.resolve({ tip: OID(3), merged: false, uncommitted: 0 });
    await now;
    expect(o.of(two ?? '')).toEqual({ merged: true, uncommitted: 2 });
    expect(most).toBe(1);
  });

  it('publishes a canvas again only when what it shows of it changed', async () => {
    const [one] = await trees(canvas, REPOSITORIES[0] ?? '', 1);
    const reads = fakeReads();
    const changed = vi.fn<(canvas: CanvasId) => void>();
    const o = observe(reads, changed);
    await o.now(canvas, one);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(canvas);
    await o.now(canvas, one);
    expect(changed).toHaveBeenCalledTimes(1);
    reads.workspace.mockResolvedValue({ tip: OID(4), merged: false, uncommitted: 3 });
    await o.now(canvas, one);
    expect(changed).toHaveBeenCalledTimes(2);
    // A tip that moved, showing the same: nothing new to publish.
    reads.workspace.mockResolvedValue({ tip: OID(5), merged: false, uncommitted: 3 });
    await o.now(canvas, one);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('shows nothing observed of a tree no longer in use, or made again since', async () => {
    const [one] = await trees(canvas, REPOSITORIES[0] ?? '', 1);
    const reads = fakeReads();
    const o = observe(reads);
    await o.now(canvas, one);
    expect(o.of(one ?? '')).toEqual({ merged: false, uncommitted: 0 });
    await workspaces.write((w) => {
      w.transition(one ?? '', { from: 'ready', to: 'missing', errorCode: 'checkout-missing' });
    });
    expect(o.of(one ?? '')).toEqual({ merged: null, uncommitted: null });
  });

  it('reads nothing once closed', async () => {
    const [one] = await trees(canvas, REPOSITORIES[0] ?? '', 1);
    const reads = fakeReads();
    const o = observe(reads);
    o.workspace(one ?? '');
    o.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await o.now(canvas, one);
    expect(reads.workspace).not.toHaveBeenCalled();
    expect(reads.into).not.toHaveBeenCalled();
  });
});
