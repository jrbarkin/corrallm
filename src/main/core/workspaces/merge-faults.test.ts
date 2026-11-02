import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mintTrustedPath } from '../host';
import type { TrustedPath } from '../host';
import { refuseWrites } from '../store/test-store';
import { upgradeIdentities } from './discovery';
import { GitError, GitRunner } from './git';
import type { GitOutput } from './git';
import type { MergeResult } from './merge';
import { differing, listing } from './test-git';
import { crashAt, mergeWorld, pauseAt, put } from './test-merge';
import type { MergeWorld } from './test-merge';
import { CANVAS } from './test-workspace';

/*
 * B9b Design §9.3, phase by phase: a crash (the core stopping where it is, its writes so far on
 * disk) before, during and after each step, and a failure at each, then what a restart finds and
 * does. A crash is the service stopping at a point and never going on; the restart is a new
 * service over the same profile, which reconciles every merge left going on by what your checkout
 * shows, never by running it again: one never installed is `interrupted` (nothing changed, true),
 * one installed (or whose Git stopped between its index and its branch) is finished and `merged`,
 * anything else `held`, nothing reset and no lock removed. Real Git, throwaway repositories.
 */

vi.setConfig({ testTimeout: 90_000 });

let world: MergeWorld | undefined;
afterEach(async () => {
  await world?.service.drained();
  await world?.close();
  world = undefined;
});

async function make(options: Parameters<typeof mergeWorld>[0] = {}): Promise<MergeWorld> {
  world = await mergeWorld(options);
  return world;
}

type Answer = Awaited<ReturnType<MergeWorld['service']['merge']>>;

function merged(result: Answer): MergeResult {
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

function refusal(result: Answer): { code: string; sentence: string } {
  if (result.ok) throw new Error(`Merged: ${JSON.stringify(result.value)}`);
  return result.error;
}

/** Your checkout and its Git directories but their objects. */
function everything(w: MergeWorld): Record<string, string> {
  return listing(w.app, (relative) => relative === path.join('.git', 'objects'));
}

/** An agent with a commit of its own and main moved on: a merge to make. */
function diverged(w: MergeWorld): { tip: string; before: string } {
  const tip = w.work(w.cwd, { 'agent.txt': 'agent\n' }, 'agent work');
  const before = w.work(w.app, { 'main.txt': 'main\n' }, 'main work');
  return { tip, before };
}

/** The agent's uncommitted work, and its digest as Review changes shows it. */
async function uncommitted(w: MergeWorld): Promise<string> {
  put(w.cwd, 'draft.txt', 'draft\n');
  const { inventoryUncommitted } = await import('./uncommitted');
  const read = await inventoryUncommitted(w.git, {
    cwd: w.cwd,
    tip: w.g(w.cwd, 'rev-parse', 'HEAD'),
    drivers: [],
    copied: [],
  });
  if (!read.ok || read.value.digest === null) throw new Error(JSON.stringify(read));
  return read.value.digest;
}

/** A merge started that crashes at `point`: its request, once the crash is reached. */
async function crashing(
  point: Parameters<typeof crashAt>[0],
  options: { checkpoint?: boolean } = {},
): Promise<{
  w: MergeWorld;
  request: ReturnType<MergeWorld['request']>;
  tip: string;
  before: string;
}> {
  const crash = crashAt(point);
  const w = await make({ deps: { fault: crash.fault } });
  const { tip, before } = diverged(w);
  const digest = options.checkpoint === true ? await uncommitted(w) : undefined;
  const request = w.request(
    digest === undefined ? {} : { uncommitted: { choice: 'commit', digest } },
  );
  void w.service.merge(request);
  await crash.reached;
  return { w, request, tip, before };
}

/** The core starts again: a new service, its reconciliation done. */
async function restart(w: MergeWorld): Promise<void> {
  await w.restart().reconcile();
}

describe.skipIf(process.platform === 'win32')('a crash at each phase, and the restart', () => {
  it('step 2 (admitted): nothing recorded or changed; the restart finds nothing, and a merge goes on', async () => {
    const { w, before } = await crashing('admitted');
    const was = everything(w);
    await restart(w);
    expect(w.journal.open()).toEqual([]);
    expect(differing(was, everything(w))).toEqual([]);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(merged(await w.service.merge(w.request())).outcome).toBe('merged');
  });

  it('step 4 (prepared): only objects nothing reaches; nothing recorded; nothing to reconcile', async () => {
    const { w, before } = await crashing('prepared');
    expect(w.journal.open()).toEqual([]);
    await restart(w);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(w.g(w.app, 'status', '--porcelain')).toBe('');
  });

  it('step 5 (recorded): never installed, so interrupted, nothing changed, and its request says so', async () => {
    const { w, request, before } = await crashing('recorded');
    const job = w.journal.open()[0];
    expect(job).toMatchObject({ phase: 'installing', outcome: null });
    const was = everything(w);

    await restart(w);

    expect(w.journal.job(job?.id ?? '')).toMatchObject({
      outcome: 'interrupted',
      sentence: expect.stringMatching(/nothing changed/i) as unknown,
    });
    expect(differing(was, everything(w))).toEqual([]);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    // Its request is answered from the journal: never run again.
    expect(refusal(await w.service.merge(request))).toMatchObject({
      code: 'unavailable',
      sentence: expect.stringMatching(/nothing changed/i) as unknown,
    });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
  });

  it('step 7 (the point of no return), before Git wrote anything: interrupted, nothing changed', async () => {
    const { w } = await crashing('installing');
    const was = everything(w);
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'interrupted' });
    expect(differing(was, everything(w))).toEqual([]);
  });

  it('step 7, Git having written only ORIG_HEAD: put back as recorded, interrupted', async () => {
    const { w, before } = await crashing('installing');
    expect(w.journal.open()[0]?.intent.origHead).toBeNull();
    // What Git writes first: the HEAD it starts from.
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', before);
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'interrupted' });
    expect(existsSync(path.join(w.app, '.git', 'ORIG_HEAD'))).toBe(false);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
  });

  it('keeps a recorded ORIG_HEAD when the interrupted install never wrote it', async () => {
    const crash = crashAt('installing');
    const w = await make({ deps: { fault: crash.fault } });
    const { tip, before } = diverged(w);
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', tip);
    void w.service.merge(w.request());
    await crash.reached;
    const was = everything(w);

    await restart(w);

    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'interrupted' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(w.g(w.app, 'rev-parse', 'ORIG_HEAD')).toBe(tip);
    expect(differing(was, everything(w))).toEqual([]);
  });

  it('holds an otherwise untouched restart when ORIG_HEAD differs from both recorded commits', async () => {
    const { w, tip, before } = await crashing('installing');
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', tip);
    const was = everything(w);

    await restart(w);

    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(w.g(w.app, 'rev-parse', 'ORIG_HEAD')).toBe(tip);
    expect(differing(was, everything(w))).toEqual([]);
  });

  it('step 7, Git having written your index and files but not your branch: the branch moved to the merge, merged', async () => {
    const { w, request, tip, before } = await crashing('installing');
    const m = w.journal.open()[0]?.intent.merge.commit ?? '';
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', before);
    w.g(w.app, 'read-tree', '-m', '-u', before, m);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);

    await restart(w);

    expect(w.g(w.app, 'rev-parse', 'main')).toBe(m);
    expect(w.g(w.app, 'status', '--porcelain')).toBe('');
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged', phase: 'done' });
    expect(merged(await w.service.merge(request))).toEqual({
      outcome: 'merged',
      source: tip,
      into: { ref: 'refs/heads/main', before, after: m },
      mergeCommit: m,
    });
  });

  it('checks the destination again after finishing an interrupted branch update', async () => {
    const { w, before } = await crashing('installing', { checkpoint: true });
    const job = w.journal.open()[0];
    const m = job?.intent.merge.commit ?? '';
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', before);
    w.g(w.app, 'read-tree', '-m', '-u', before, m);
    const run = w.git.run.bind(w.git);
    let finished = false;
    const read = vi.spyOn(w.git, 'run').mockImplementation(async (call) => {
      const result = await run(call);
      if (call.args.includes('corrallm: finish an interrupted merge')) {
        finished = true;
        put(w.app, 'README.md', 'changed while the branch update finished\n');
      }
      return result;
    });
    try {
      await restart(w);
    } finally {
      read.mockRestore();
    }

    expect(finished).toBe(true);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(m);
    expect(readFileSync(path.join(w.app, 'README.md'), 'utf8')).toBe(
      'changed while the branch update finished\n',
    );
    expect(w.g(w.cwd, 'rev-parse', 'HEAD')).toBe(job?.intent.source.tip);
    expect(w.g(w.cwd, 'ls-files', '--', 'draft.txt')).toBe('');
  });

  it('step 7, Git stopped part way with your index locked: held, nothing reset and no lock removed', async () => {
    const { w, before } = await crashing('installing');
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', before);
    writeFileSync(path.join(w.app, 'agent.txt'), 'agent\n');
    writeFileSync(path.join(w.app, '.git', 'index.lock'), 'half\n');
    const was = everything(w);

    await restart(w);

    expect(w.journal.latest(w.tree.id)).toMatchObject({
      outcome: 'held',
      sentence: expect.stringMatching(/may be partly merged: check git status/) as unknown,
    });
    expect(differing(was, everything(w))).toEqual([]);
    expect(readFileSync(path.join(w.app, '.git', 'index.lock'), 'utf8')).toBe('half\n');
    // It says so on the agent's card.
    expect(w.service.state(w.tree.id)).toMatchObject({ job: 'held' });
  });

  it('step 8 (installed, not yet checked): finished as merged, once', async () => {
    const { w, request } = await crashing('installed');
    const m = w.journal.open()[0]?.intent.merge.commit;
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(m);
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged', phase: 'done' });
    expect(merged(await w.service.merge(request))).toMatchObject({ mergeCommit: m });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(m);
  });

  it('step 9 (checked, its checkpoint not yet on the agent’s branch): published by the restart, its index reset, merged', async () => {
    const { w, tip } = await crashing('verified', { checkpoint: true });
    const job = w.journal.open()[0];
    expect(job?.phase).toBe('installed');
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(tip);

    await restart(w);

    const checkpoint = job?.intent.source.checkpoint;
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(checkpoint);
    expect(w.g(w.cwd, 'status', '--porcelain')).toBe('');
    expect(w.journal.job(job?.id ?? '')).toMatchObject({ outcome: 'merged', phase: 'done' });
  });

  it('step 9, its checkpoint on the agent’s branch but its index not reset: reset by the restart, merged', async () => {
    const { w } = await crashing('published', { checkpoint: true });
    const job = w.journal.open()[0];
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(job?.intent.source.checkpoint);
    // Its index still the tip's: the work reads as staged reversals until it is reset.
    expect(w.g(w.cwd, 'status', '--porcelain')).not.toBe('');

    await restart(w);

    expect(w.g(w.cwd, 'status', '--porcelain')).toBe('');
    expect(w.journal.job(job?.id ?? '')).toMatchObject({ outcome: 'merged', phase: 'done' });
  });

  it('step 10 (all done, not settled): settled merged by the restart', async () => {
    const { w } = await crashing('reset', { checkpoint: true });
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged', phase: 'done' });
    expect(w.g(w.cwd, 'status', '--porcelain')).toBe('');
  });

  it('step 8 into a linked picked checkout: found again by its own Git directory, merged', async () => {
    const crash = crashAt('installed');
    const w = await make({ linked: 'feature', deps: { fault: crash.fault } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    void w.service.merge(w.request());
    await crash.reached;
    const m = w.journal.open()[0]?.intent.merge.commit;
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged', phase: 'done' });
    expect(w.g(w.picked, 'rev-parse', 'feature')).toBe(m);
    expect(w.g(w.app, 'rev-parse', 'main')).not.toBe(m);
  });

  it('step 8, recorded by a corrallm keeping identities in the form before v2: found again once its repository’s record is rewritten, merged', async () => {
    const { w } = await crashing('installed');
    const job = w.journal.open()[0];
    if (job === undefined) throw new Error('No merge left going on.');
    const m = job.intent.merge.commit;
    // As that corrallm recorded them: the repository and the merge's destination by the common
    // directory's inode alone. The journal's intent is never rewritten.
    const before = `git common-dir inode ${statSync(w.record.commonDir, { bigint: true }).ino.toString()}`;
    const intent = JSON.stringify({
      ...job.intent,
      destination: { ...job.intent.destination, identity: before },
    });
    await w.store.write(() => {
      w.store
        .prepare('UPDATE merge_job SET intent = ?, intent_hash = ? WHERE id = ?')
        .run(intent, createHash('sha256').update(intent).digest('hex'), job.id);
      w.store.prepare('UPDATE repository SET identity = ? WHERE id = ?').run(before, w.record.id);
    });
    // The next core rewrites its repository's record as it starts, comparing the inode once.
    expect(await upgradeIdentities(w.workspaces)).toBe(1);
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged', phase: 'done' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(m);
  });

  it('after settling, its answer lost: the repeated request is answered, nothing merged twice', async () => {
    const w = await make();
    diverged(w);
    const request = w.request();
    const first = merged(await w.service.merge(request));
    await restart(w);
    expect(merged(await w.service.merge(request))).toEqual(first);
    expect(w.g(w.app, 'rev-list', '--count', '--merges', 'main')).toBe('1');
  });

  it('never merges again into a checkout that moved while the core was down: held', async () => {
    const { w } = await crashing('recorded');
    const moved = w.work(w.app, { 'later.txt': 'yours\n' }, 'your later work');
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(moved);
  });

  it('holds new work in the agent’s tree, and merges into its repository, until its merge is reconciled', async () => {
    const { w } = await crashing('recorded');
    const picked = Promise.withResolvers<TrustedPath | undefined>();
    const service = w.restart({ pickedRoot: () => picked.promise });
    const reconciling = service.reconcile();
    expect(await w.gate.holding(CANVAS, 'builder')).toMatch(/merge/i);
    let answered = false;
    const next = service.merge(w.request()).then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    picked.resolve(mintTrustedPath(w.app));
    await reconciling;
    expect(await w.gate.holding(CANVAS, 'builder')).toBeUndefined();
    expect(merged(await next).outcome).toBe('merged');
  });
});

describe.skipIf(process.platform === 'win32')('a failure at each phase', () => {
  it('a journal that can’t record the merge: refused, nothing changed', async () => {
    const w = await make();
    const { before } = diverged(w);
    const was = everything(w);
    const release = refuseWrites(w.profile, 'merge_job', 'The disk is full');
    try {
      expect(refusal(await w.service.merge(w.request()))).toMatchObject({ code: 'unavailable' });
    } finally {
      release();
    }
    expect(differing(was, everything(w))).toEqual([]);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    // Once it can, the same merge goes on.
    expect(merged(await w.service.merge(w.request())).outcome).toBe('merged');
  });

  it('a journal that can’t settle an installed merge: says it is in your checkout, and the restart settles it merged', async () => {
    const pause = pauseAt('installed');
    const w = await make({ deps: { fault: pause.fault } });
    diverged(w);
    const going = w.service.merge(w.request());
    await pause.reached;
    const release = refuseWrites(w.profile, 'merge_job', 'The disk is full');
    pause.resume();
    const answer = refusal(await going);
    release();
    expect(answer.code).toBe('unavailable');
    expect(answer.sentence).toMatch(/is in your checkout/);
    expect(answer.sentence).not.toMatch(/nothing changed/i);
    await restart(w);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged' });
  });

  it('an install ended by its time bound: held, never “nothing changed”', async () => {
    class Slow extends GitRunner {
      override install(): Promise<GitOutput> {
        return Promise.reject(new GitError('timeout', 'git took too long.'));
      }
    }
    const w = await make({ git: (made) => new Slow(made.runnerDeps) });
    diverged(w);
    const answer = refusal(await w.service.merge(w.request()));
    expect(answer.code).toBe('unavailable');
    expect(answer.sentence).toMatch(/may be partly merged/);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
  });

  it('your checkout changed during the install: held, saying so; superseded by the next merge into it', async () => {
    const pause = pauseAt('installed');
    const w = await make({ deps: { fault: pause.fault } });
    diverged(w);
    const going = w.service.merge(w.request());
    await pause.reached;
    writeFileSync(path.join(w.app, 'README.md'), 'yours, meanwhile\n');
    pause.resume();
    const answer = refusal(await going);
    expect(answer.code).toBe('unavailable');
    expect(answer.sentence).toMatch(/may be partly merged: check git status/);
    const held = w.journal.latest(w.tree.id);
    expect(held?.outcome).toBe('held');
    expect(readFileSync(path.join(w.app, 'README.md'), 'utf8')).toBe('yours, meanwhile\n');

    // You put your checkout right; the next merge into it supersedes the held one.
    w.g(w.app, 'checkout', '--', 'README.md');
    w.work(w.cwd, { 'more.txt': 'more\n' });
    expect(merged(await w.service.merge(w.request())).outcome).toBe('merged');
    expect(w.journal.job(held?.id ?? '')?.outcome).toBe('superseded');
  });

  it('an edit during the install, seen whatever the repository’s stat settings: held', async () => {
    const pause = pauseAt('installed');
    const w = await make({ deps: { fault: pause.fault } });
    diverged(w);
    const going = w.service.merge(w.request());
    await pause.reached;
    const file = path.join(w.app, 'README.md');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
    w.g(w.app, 'update-index', '--refresh');
    w.g(w.app, 'config', 'core.trustctime', 'false');
    w.g(w.app, 'config', 'core.checkStat', 'minimal');
    // Past a timestamp's tick, an edit of the same size, its old modification time put back.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    writeFileSync(file, 'HELLO\n');
    utimesSync(file, old, old);
    pause.resume();
    expect(refusal(await going).sentence).toMatch(/may be partly merged/);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'holds an installed merge when its destination index marks a file %s',
    async (flag) => {
      const pause = pauseAt('installed');
      const w = await make({ deps: { fault: pause.fault } });
      diverged(w);
      const going = w.service.merge(w.request());
      await pause.reached;
      w.g(w.app, 'update-index', flag, 'README.md');
      put(w.app, 'README.md', 'changed after install\n');
      const was = everything(w);
      pause.resume();

      expect(refusal(await going).sentence).toMatch(/may be partly merged/);
      expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
      expect(differing(was, everything(w))).toEqual([]);
      expect(readFileSync(path.join(w.app, 'README.md'), 'utf8')).toBe('changed after install\n');
    },
  );

  it('holds a refused install when its ORIG_HEAD can no longer be restored', async () => {
    const pause = pauseAt('installing');
    const w = await make({ deps: { fault: pause.fault } });
    const { before } = diverged(w);
    const tip = w.work(w.cwd, { 'late.txt': 'agent\n' });
    const install = w.git.install.bind(w.git);
    let refused = false;
    const refusalAt = vi.spyOn(w.git, 'install').mockImplementation(async (call) => {
      try {
        return await install(call);
      } catch (error) {
        refused = true;
        w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', tip);
        throw error;
      }
    });
    const going = w.service.merge(w.request());
    await pause.reached;
    put(w.app, 'late.txt', 'your file\n');
    pause.resume();
    let answer;
    try {
      answer = await going;
    } finally {
      refusalAt.mockRestore();
    }

    expect(refused).toBe(true);
    expect(refusal(answer).sentence).toMatch(/may be partly merged/);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(w.g(w.app, 'rev-parse', 'ORIG_HEAD')).toBe(tip);
    expect(readFileSync(path.join(w.app, 'late.txt'), 'utf8')).toBe('your file\n');
  });

  it('an install that didn’t start from your commit (ORIG_HEAD says another): held', async () => {
    const pause = pauseAt('installed');
    const w = await make({ deps: { fault: pause.fault } });
    const { tip } = diverged(w);
    const going = w.service.merge(w.request());
    await pause.reached;
    // What Git writes is the HEAD it started from: another one means your branch moved under it.
    w.g(w.app, 'update-ref', '--no-deref', 'ORIG_HEAD', tip);
    pause.resume();
    expect(refusal(await going).sentence).toMatch(/may be partly merged/);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'held' });
  });

  it('an agent’s branch moved before its checkpoint was published: merged, the work not recorded on it, its files keeping it', async () => {
    const pause = pauseAt('verified');
    const w = await make({ deps: { fault: pause.fault } });
    diverged(w);
    const digest = await uncommitted(w);
    const going = w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } }));
    await pause.reached;
    const moved = w.work(w.cwd, { 'typed.txt': 'typed in its terminal\n' }, 'by hand');
    pause.resume();
    const result = merged(await going);
    expect(result).toMatchObject({ outcome: 'merged', recorded: false });
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(moved);
    expect(readFileSync(path.join(w.cwd, 'draft.txt'), 'utf8')).toBe('draft\n');
    expect(existsSync(path.join(w.app, 'draft.txt'))).toBe(true);
  });
});
