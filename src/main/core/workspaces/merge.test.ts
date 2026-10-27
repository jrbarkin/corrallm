import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import type { Caller } from '../caller';
import { mintTrustedPath } from '../host';

import { mergeCallerOf } from './merge';
import type { MergeResult } from './merge';
import { differing, gitInits, hooksInto, listing, ran, sentinelProgram } from './test-git';
import { crashAt, mergeWorld, pauseAt, put, YOU } from './test-merge';
import type { MergeWorld } from './test-merge';
import { CANVAS } from './test-workspace';

/*
 * B9b's merge service (Design §9 C5 to C9, §9.3), against real Git in throwaway repositories,
 * hostile ones included: an agent's branch merged into the branch your picked checkout is on as a
 * two-parent merge commit, prepared away from your checkout and installed by a fast-forward; the
 * agent's uncommitted work committed on its own branch only when chosen, bound to what was
 * reviewed; every refusal before anything of your checkout changes; no program a repository
 * configures run on success or failure; one merge at a time per repository; and the shutdown
 * barrier, which waits for an install and refuses what hasn't reached it.
 */

// Real Git, a repository and a worktree or two each: slower under load, or on Linux CI.
vi.setConfig({ testTimeout: 90_000 });

const SHA256 = gitInits('--object-format=sha256');
const REFTABLE = gitInits('--ref-format=reftable');

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

function merged(result: Awaited<ReturnType<MergeWorld['service']['merge']>>): MergeResult {
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

function refusal(result: Awaited<ReturnType<MergeWorld['service']['merge']>>): {
  code: string;
  sentence: string;
} {
  if (result.ok) throw new Error(`Merged: ${JSON.stringify(result.value)}`);
  return result.error;
}

/** Your checkout and every Git directory of it but its objects (the agent's checkout included). */
function everything(w: MergeWorld): Record<string, string> {
  return listing(w.app, (relative) => relative === path.join('.git', 'objects'));
}

/** What Git and the files say of `cwd`: nothing listed is clean. */
function status(w: MergeWorld, cwd: string): string {
  return w.g(cwd, 'status', '--porcelain=v1', '--untracked-files=all');
}

describe.skipIf(process.platform === 'win32')('a merge', () => {
  it('merges an agent’s committed work into your branch as a two-parent commit by you, writing only your checkout', async () => {
    const w = await make();
    const tip = w.work(w.cwd, { 'agent.txt': 'agent\n' }, 'agent work');
    const before = w.work(w.app, { 'main.txt': 'main\n' }, 'main work');
    const agentBefore = listing(w.cwd);

    const result = merged(await w.service.merge(w.request()));

    const after = w.g(w.app, 'rev-parse', 'main');
    expect(result).toEqual({
      outcome: 'merged',
      source: tip,
      into: { ref: 'refs/heads/main', before, after },
      mergeCommit: after,
    });
    expect(w.g(w.app, 'rev-list', '--parents', '-n1', after)).toBe(`${after} ${before} ${tip}`);
    expect(w.g(w.app, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', after)).toBe(
      `${YOU.name} <${YOU.email}>|${YOU.name} <${YOU.email}>`,
    );
    expect(w.g(w.app, 'log', '-1', '--format=%B', after)).toBe(
      `Merge branch '${w.tree.branchRef.slice('refs/heads/'.length)}' into main\n\nCorrallm-Requested-By: you`,
    );
    expect(w.g(w.app, 'log', '-1', '--format=%G?', after)).toBe('N');
    // Your checkout is the merge: its files, its index, HEAD on main.
    expect(readFileSync(path.join(w.app, 'agent.txt'), 'utf8')).toBe('agent\n');
    expect(status(w, w.app)).toBe('');
    expect(w.g(w.app, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    // The agent's checkout and branch as they were.
    expect(differing(agentBefore, listing(w.cwd))).toEqual([]);
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(tip);
    // Journaled, settled.
    expect(w.journal.latest(w.tree.id)).toMatchObject({
      outcome: 'merged',
      phase: 'done',
      callerKey: 'you',
      intent: { requester: 'you', destination: { oid: before }, merge: { commit: after } },
    });
  });

  it('makes a merge commit where a fast-forward was possible, its tree the agent’s', async () => {
    const w = await make();
    const tip = w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const before = w.g(w.app, 'rev-parse', 'main');

    const result = merged(await w.service.merge(w.request()));

    const after = w.g(w.app, 'rev-parse', 'main');
    expect(result).toMatchObject({ outcome: 'merged', mergeCommit: after });
    expect(w.g(w.app, 'rev-list', '--parents', '-n1', after)).toBe(`${after} ${before} ${tip}`);
    expect(w.g(w.app, 'rev-parse', `${after}^{tree}`)).toBe(
      w.g(w.app, 'rev-parse', `${tip}^{tree}`),
    );
  });

  it('says an integrated tip is already merged, writing nothing', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    merged(await w.service.merge(w.request()));
    const before = everything(w);
    const jobs = w.journal.open().length;

    const again = merged(await w.service.merge(w.request()));

    const head = w.g(w.app, 'rev-parse', 'main');
    expect(again).toEqual({
      outcome: 'already-merged',
      source: w.g(w.app, 'rev-parse', w.tree.branchRef),
      into: { ref: 'refs/heads/main', before: head, after: head },
    });
    expect(differing(before, everything(w))).toEqual([]);
    expect(w.journal.open()).toHaveLength(jobs);
  });

  it('answers a repeated request with its first result, after a restart too, merging once', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const request = w.request();
    const first = merged(await w.service.merge(request));
    const head = w.g(w.app, 'rev-parse', 'main');

    expect(merged(await w.service.merge(request))).toEqual(first);
    w.restart();
    await w.service.reconcile();
    expect(merged(await w.service.merge(request))).toEqual(first);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(head);
    // The same id with other arguments isn't that request.
    const other = refusal(
      await w.service.merge({ ...request, into: { ref: 'refs/heads/main', oid: head } }),
    );
    expect(other.code).toBe('conflict');
    // Another caller's request of the same id is its own: its pins are stale, so it is refused.
    const token = refusal(
      await w.service.merge({
        ...request,
        caller: {
          key: 'token:0f1e2d3c-4b5a-4968-8776-655443322110',
          requester: 'outside:orchestrator',
        },
      }),
    );
    expect(token.code).toBe('conflict');
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(head);
  });

  it('merges into a linked picked checkout: its own index and HEAD, the main checkout untouched', async () => {
    // The canvas's project folder is a linked checkout of the repository, on feature.
    const w = await make({ linked: 'feature' });
    const linked = w.picked;
    /** The main checkout and its Git directory but the linked checkouts' and objects. */
    const main = () =>
      listing(w.app, (relative) =>
        [path.join('.git', 'objects'), path.join('.git', 'worktrees')].includes(relative),
      );
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const before = w.g(linked, 'rev-parse', 'feature');
    const was = main();

    const result = merged(await w.service.merge(w.request()));

    expect(result.into).toMatchObject({ ref: 'refs/heads/feature', before });
    expect(w.g(linked, 'rev-parse', 'feature')).toBe(result.into.after);
    expect(existsSync(path.join(linked, 'agent.txt'))).toBe(true);
    expect(status(w, linked)).toBe('');
    // The main checkout, its index, HEAD and logs as they were: only feature's ref and log moved.
    expect(differing(was, main())).toEqual([
      path.join('.git', 'logs', 'refs', 'heads', 'feature'),
      path.join('.git', 'refs', 'heads', 'feature'),
    ]);
    expect(existsSync(path.join(w.app, 'agent.txt'))).toBe(false);
  });

  it.skipIf(!SHA256)('merges in a SHA-256 repository, its checkpoint too', async () => {
    const w = await make({ init: ['--object-format=sha256'] });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    put(w.cwd, 'draft.txt', 'draft\n');
    const digest = await reviewDigest(w);
    const result = merged(
      await w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } })),
    );
    expect(result.outcome).toBe('merged');
    expect(result.source).toHaveLength(64);
    expect(result).toMatchObject({ checkpoint: w.g(w.app, 'rev-parse', w.tree.branchRef) });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(result.into.after);
    expect(status(w, w.cwd)).toBe('');
  });

  it.skipIf(!REFTABLE)('merges in a reftable repository', async () => {
    const w = await make({ init: ['--ref-format=reftable'] });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const result = merged(await w.service.merge(w.request()));
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(result.into.after);
    expect(status(w, w.app)).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('a refused merge changes nothing', () => {
  it('refuses a dirty checkout: staged, unstaged and untracked work', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    for (const dirty of [
      () => {
        writeFileSync(path.join(w.app, 'README.md'), 'edited\n');
      },
      () => {
        writeFileSync(path.join(w.app, 'README.md'), 'staged\n');
        w.g(w.app, 'add', 'README.md');
      },
      () => {
        writeFileSync(path.join(w.app, 'new.txt'), 'untracked\n');
      },
    ]) {
      w.g(w.app, 'reset', '-q', '--hard');
      w.g(w.app, 'clean', '-qfd', '-e', '.corral');
      dirty();
      const before = everything(w);
      const refused = refusal(await w.service.merge(w.request()));
      expect(refused).toMatchObject({ code: 'refused' });
      expect(refused.sentence).toMatch(/uncommitted changes/);
      expect(differing(before, everything(w))).toEqual([]);
    }
    expect(w.journal.latest(w.tree.id)).toBeUndefined();
  });

  it('refuses a conflict naming its files, leaving no merge state, nothing changed', async () => {
    const w = await make();
    w.work(w.cwd, { 'README.md': 'agent\n' });
    w.work(w.app, { 'README.md': 'main\n' });
    const before = everything(w);

    const refused = refusal(await w.service.merge(w.request()));

    expect(refused.code).toBe('conflict');
    expect(refused.sentence).toMatch(/"README\.md"/);
    expect(differing(before, everything(w))).toEqual([]);
    expect(existsSync(path.join(w.app, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('refuses when your branch or the agent’s moved since the caller looked', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const stale = w.request();
    w.work(w.app, { 'main.txt': 'main\n' });
    expect(refusal(await w.service.merge(stale))).toMatchObject({ code: 'conflict' });
    const fresh = w.request();
    w.work(w.cwd, { 'more.txt': 'more\n' });
    expect(refusal(await w.service.merge(fresh))).toMatchObject({ code: 'conflict' });
    const switched = w.request();
    w.g(w.app, 'switch', '-q', '-c', 'other');
    expect(refusal(await w.service.merge(switched))).toMatchObject({ code: 'conflict' });
  });

  it('refuses without your Git identity, asking you to set one', async () => {
    const w = await make({ identity: false });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const before = everything(w);
    const refused = refusal(await w.service.merge(w.request()));
    expect(refused).toMatchObject({ code: 'refused' });
    expect(refused.sentence).toMatch(/Set your Git name and email/);
    expect(differing(before, everything(w))).toEqual([]);
  });

  it('refuses while a member of the agent’s tree may be writing, or its tree isn’t ready or waits', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    w.writing.set('builder', 'has a turn going on');
    expect(refusal(await w.service.merge(w.request()))).toMatchObject({
      code: 'unavailable',
      sentence: expect.stringMatching(/Builder has a turn going on/) as unknown,
    });
    w.writing.clear();
    await w.workspaces.write((s) => {
      s.transition(w.tree.id, { from: 'ready', to: 'setup' });
    });
    expect(refusal(await w.service.merge(w.request()))).toMatchObject({ code: 'unavailable' });
    await w.workspaces.write((s) => {
      s.transition(w.tree.id, { from: 'setup', to: 'ready' });
      s.plan(CANVAS, 'builder', 'agent/elsewhere');
    });
    expect(refusal(await w.service.merge(w.request()))).toMatchObject({
      code: 'unavailable',
      sentence: expect.stringMatching(/Switch/) as unknown,
    });
  });

  it('refuses while an agent works in your checkout itself', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    w.trees.set('legacy', [`folder:${w.app}`]);
    expect(refusal(await w.service.merge(w.request()))).toMatchObject({ code: 'unavailable' });
    w.trees.delete('legacy');
    expect(merged(await w.service.merge(w.request())).outcome).toBe('merged');
  });

  it('refuses at its last check an ORIG_HEAD that became a symbolic ref, settling it, nothing changed', async () => {
    const pause = pauseAt('recorded');
    const w = await make({ deps: { fault: pause.fault } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const before = w.g(w.app, 'rev-parse', 'main');
    const going = w.service.merge(w.request());
    await pause.reached;
    w.g(w.app, 'symbolic-ref', 'ORIG_HEAD', 'refs/heads/main');
    const was = everything(w);
    pause.resume();
    expect(refusal(await going)).toMatchObject({
      code: 'refused',
      sentence: expect.stringMatching(/ORIG_HEAD is a symbolic ref/) as unknown,
    });
    expect(differing(was, everything(w))).toEqual([]);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'refused' });
  });

  it('refuses a merge that writes a file your repository filters, naming it and the merge to run yourself', async () => {
    const w = await make({
      files: { 'README.md': 'hello\n', '.gitattributes': '*.bin filter=lfs\n' },
    });
    w.work(w.cwd, { 'asset.bin': 'pointer\n', 'plain.txt': 'plain\n' });
    // Configured once the agent's commit is made (the test's own git would run it).
    w.g(w.app, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    const before = everything(w);
    const refused = refusal(await w.service.merge(w.request()));
    expect(refused.code).toBe('refused');
    expect(refused.sentence).toMatch(/"asset\.bin"/);
    expect(refused.sentence).toMatch(/git merge --no-ff corrallm\//);
    expect(differing(before, everything(w))).toEqual([]);
  });

  it('refuses an ignored file where the merge writes, naming it', async () => {
    const w = await make();
    put(w.cwd, 'debug.log', 'tracked by the agent\n');
    w.g(w.cwd, 'add', '--force', 'debug.log');
    w.work(w.cwd, {});
    writeFileSync(path.join(w.app, 'debug.log'), 'precious\n');
    const refused = refusal(await w.service.merge(w.request()));
    expect(refused.code).toBe('refused');
    expect(refused.sentence).toMatch(/"debug\.log"/);
    expect(readFileSync(path.join(w.app, 'debug.log'), 'utf8')).toBe('precious\n');
  });

  it('refuses, nothing changed, where Git refuses the install over a file put in its way at the last moment', async () => {
    const pause = pauseAt('installing');
    const w = await make({ deps: { fault: pause.fault } });
    w.work(w.cwd, { 'late.txt': 'agent\n' });
    const going = w.service.merge(w.request());
    await pause.reached;
    // Past every check of ours: Git's own, at the install, is the guarantee.
    writeFileSync(path.join(w.app, 'late.txt'), 'yours\n');
    const before = everything(w);
    pause.resume();

    const refused = refusal(await going);

    expect(refused.code).toBe('refused');
    expect(refused.sentence).toMatch(/"late\.txt"/);
    expect(refused.sentence).toMatch(/nothing changed/i);
    expect(differing(before, everything(w))).toEqual([]);
    expect(readFileSync(path.join(w.app, 'late.txt'), 'utf8')).toBe('yours\n');
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'refused' });
  });
});

describe.skipIf(process.platform === 'win32')('an agent’s uncommitted work', () => {
  it('is required to be chosen: refused without a choice, its count said', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    put(w.cwd, 'draft.txt', 'draft\n');
    put(w.cwd, 'agent.txt', 'edited\n');
    const refused = refusal(await w.service.merge(w.request()));
    expect(refused.code).toBe('refused');
    expect(refused.sentence).toMatch(/2 uncommitted files/);
  });

  it('is left in its worktree when you merge its commits without it', async () => {
    const w = await make();
    const tip = w.work(w.cwd, { 'agent.txt': 'agent\n' });
    put(w.cwd, 'draft.txt', 'draft\n');
    const agentBefore = listing(w.cwd);

    const result = merged(await w.service.merge(w.request({ uncommitted: { choice: 'leave' } })));

    expect(result).toMatchObject({ outcome: 'merged', source: tip });
    expect(existsSync(path.join(w.app, 'draft.txt'))).toBe(false);
    expect(differing(agentBefore, listing(w.cwd))).toEqual([]);
  });

  it('is committed on the agent’s branch as corrallm when chosen, then merged, its index reset and its files untouched', async () => {
    const w = await make();
    const tip = w.work(w.cwd, { 'agent.txt': 'agent\n' });
    put(w.cwd, 'draft.txt', 'draft\n');
    put(w.cwd, 'agent.txt', 'edited\n');
    const digest = await reviewDigest(w);
    const files = {
      draft: readFileSync(path.join(w.cwd, 'draft.txt')),
      agent: readFileSync(path.join(w.cwd, 'agent.txt')),
    };

    const result = merged(
      await w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } })),
    );

    const checkpoint = w.g(w.app, 'rev-parse', w.tree.branchRef);
    expect(result).toMatchObject({ outcome: 'merged', source: checkpoint, checkpoint });
    expect(w.g(w.app, 'rev-list', '--parents', '-n1', checkpoint)).toBe(`${checkpoint} ${tip}`);
    expect(w.g(w.app, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B', checkpoint)).toBe(
      'corrallm <noreply@corrallm.invalid>|corrallm <noreply@corrallm.invalid>|corrallm: commit uncommitted work before merging\n\nCorrallm-Requested-By: you',
    );
    expect(readFileSync(path.join(w.app, 'draft.txt'), 'utf8')).toBe('draft\n');
    expect(readFileSync(path.join(w.app, 'agent.txt'), 'utf8')).toBe('edited\n');
    // The agent's checkout: its files as they were, its index its branch's, nothing uncommitted.
    expect(readFileSync(path.join(w.cwd, 'draft.txt'))).toEqual(files.draft);
    expect(readFileSync(path.join(w.cwd, 'agent.txt'))).toEqual(files.agent);
    expect(status(w, w.cwd)).toBe('');
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged', phase: 'done' });
    // The temporary index is gone with its job.
    expect(listing(path.join(w.profile, 'workspaces', 'merge'))).toEqual({});
  });

  it('is committed only as it was reviewed: a changed digest or a clean source is a conflict, writing nothing', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    put(w.cwd, 'draft.txt', 'draft\n');
    const digest = await reviewDigest(w);
    put(w.cwd, 'draft.txt', 'changed since\n');
    const tip = w.g(w.app, 'rev-parse', w.tree.branchRef);
    const agentIndex = readFileSync(path.join(w.app, '.git', 'worktrees', w.tree.id, 'index'));

    const refused = refusal(
      await w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } })),
    );

    expect(refused.code).toBe('conflict');
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(tip);
    expect(readFileSync(path.join(w.app, '.git', 'worktrees', w.tree.id, 'index'))).toEqual(
      agentIndex,
    );
    w.g(w.cwd, 'stash', '-u', '-q');
    expect(
      refusal(await w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } }))),
    ).toMatchObject({ code: 'conflict' });
  });

  it('never commits a local file setup copied in, whatever the caller saw', async () => {
    const w = await make({ deps: { copied: () => ['draft.txt'] } });
    put(w.cwd, 'draft.txt', 'copied from your checkout\n');
    // A digest as a review that didn't know the copy would have given.
    const digest = await reviewDigest(w);
    const tip = w.g(w.app, 'rev-parse', w.tree.branchRef);
    const refused = refusal(
      await w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } })),
    );
    expect(refused).toMatchObject({ code: 'conflict' });
    expect(refused.sentence).toMatch(/can’t commit/);
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(tip);
  });

  it('is never published when the merge would conflict: the agent’s branch and index as they were', async () => {
    const w = await make();
    w.work(w.app, { 'README.md': 'main\n' });
    put(w.cwd, 'README.md', 'agent\n');
    const digest = await reviewDigest(w);
    const tip = w.g(w.app, 'rev-parse', w.tree.branchRef);
    const before = everything(w);

    const refused = refusal(
      await w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } })),
    );

    expect(refused.code).toBe('conflict');
    expect(w.g(w.app, 'rev-parse', w.tree.branchRef)).toBe(tip);
    expect(differing(before, everything(w))).toEqual([]);
  });

  it('holds new work for every member of the agent’s tree while its work is committed and merged', async () => {
    const pause = pauseAt('installed');
    const w = await make({ deps: { fault: pause.fault } });
    put(w.cwd, 'draft.txt', 'draft\n');
    const digest = await reviewDigest(w);
    const going = w.service.merge(w.request({ uncommitted: { choice: 'commit', digest } }));
    await pause.reached;
    expect(await w.gate.holding(CANVAS, 'builder')).toMatch(/merg/i);
    expect(w.service.state(w.tree.id)).toEqual({ job: 'merging' });
    pause.resume();
    merged(await going);
    expect(await w.gate.holding(CANVAS, 'builder')).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('a hostile repository', () => {
  it('runs none of its programs, merging or refusing, which its own git merge would run', async () => {
    const w = await make({
      files: {
        'README.md': 'hello\n',
        '.gitattributes': 'merged.txt merge=hostile\n',
        'merged.txt': 'one\n',
      },
    });
    const sentinel = path.join(w.root, 'ran');
    const program = sentinelProgram(w.root, sentinel);
    hooksInto(path.join(w.app, '.git', 'hooks'), program);
    hooksInto(path.join(w.root, 'repo-hooks'), program);
    for (const [key, value] of [
      ['core.hooksPath', path.join(w.root, 'repo-hooks')],
      ['merge.hostile.driver', `${program} %O %A %B`],
      ['merge.default', 'hostile'],
      ['gpg.program', program],
      ['merge.verifySignatures', 'true'],
      ['merge.autoStash', 'true'],
      ['branch.main.mergeOptions', '--squash --verify-signatures'],
      ['diff.external', program],
      ['core.editor', program],
    ] as const) {
      w.g(w.app, 'config', key, value);
    }
    // Signing on only while corrallm works: the test's own commits would run it.
    const signing = (on: boolean) => {
      w.g(w.app, 'config', 'commit.gpgSign', String(on));
    };
    /** What ran while corrallm merged, forgetting what the test's own Git ran before. */
    const merging = async (): Promise<Awaited<ReturnType<MergeWorld['service']['merge']>>> => {
      signing(true);
      writeFileSync(sentinel, '');
      const answer = await w.service.merge(w.request());
      expect(ran(sentinel)).toEqual([]);
      signing(false);
      return answer;
    };
    w.work(w.cwd, { 'agent.txt': 'agent\n' });

    merged(await merging());

    // A merge that needs the driver fails closed, running nothing.
    w.work(w.cwd, { 'merged.txt': 'one\nagent\n' });
    w.work(w.app, { 'merged.txt': 'main\none\n' });
    const refused = refusal(await merging());
    expect(['conflict', 'refused']).toContain(refused.code);

    // The control: Git's own merge, without corrallm's options, runs them.
    signing(true);
    writeFileSync(sentinel, '');
    try {
      // Signatures not verified (its commits have none) and no squash: Git gets to the merge.
      w.g(
        w.app,
        'merge',
        '-q',
        '--no-edit',
        '--no-verify-signatures',
        '--no-squash',
        '-m',
        'control',
        w.tree.branchRef,
      );
    } catch {
      // It may fail too (its signature is the sentinel's): what ran is what counts.
    }
    expect(ran(sentinel).length).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === 'win32')('merges into one repository', () => {
  it('take turns in its lane, the second refused on the branch the first moved', async () => {
    const pause = pauseAt('recorded');
    const w = await make({ deps: { fault: pause.fault } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const first = w.service.merge(w.request());
    await pause.reached;
    const second = w.service.merge(w.request({ request: '0b6f5c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5c' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(w.journal.open()).toHaveLength(1);
    pause.resume();
    expect(merged(await first).outcome).toBe('merged');
    expect(refusal(await second).code).toBe('conflict');
  });

  it('is refused when the queue is full', async () => {
    const w = await make();
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const held = Promise.withResolvers<undefined>();
    const filling = Array.from({ length: 64 }, () =>
      w.queue.run('elsewhere', () => held.promise).catch(() => undefined),
    );
    expect(refusal(await w.service.merge(w.request()))).toMatchObject({ code: 'unavailable' });
    held.resolve(undefined);
    await Promise.all(filling);
    expect(merged(await w.service.merge(w.request())).outcome).toBe('merged');
  });
});

describe.skipIf(process.platform === 'win32')('the shutdown barrier', () => {
  it('waits for a merge past its point of no return: it is never killed to quit', async () => {
    const pause = pauseAt('installed');
    const w = await make({ deps: { fault: pause.fault } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const going = w.service.merge(w.request());
    await pause.reached;
    let closed = false;
    const closing = w.service.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    pause.resume();
    await closing;
    expect(merged(await going).outcome).toBe('merged');
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'merged' });
    // Closed: nothing more is admitted.
    expect(refusal(await w.service.merge(w.request()))).toMatchObject({ code: 'unavailable' });
  });

  it('refuses a merge that hasn’t reached it, nothing changed, and a caller who left likewise', async () => {
    const pause = pauseAt('recorded');
    const w = await make({ deps: { fault: pause.fault } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const before = w.g(w.app, 'rev-parse', 'main');
    const request = w.request();
    const going = w.service.merge(request);
    await pause.reached;
    await w.service.close();
    pause.resume();
    const closed = refusal(await going);
    expect(closed).toMatchObject({ code: 'unavailable' });
    expect(closed.sentence).toMatch(/nothing changed/);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: 'interrupted' });

    const left = new AbortController();
    const again = pauseAt('prepared');
    const service = w.restart({ fault: again.fault });
    await service.reconcile();
    // Its request, repeated after the restart, is answered as it ended.
    expect(refusal(await service.merge(request))).toEqual(closed);
    const leaving = service.merge(w.request({ signal: left.signal }));
    await again.reached;
    left.abort();
    again.resume();
    expect(refusal(await leaving)).toMatchObject({ code: 'unavailable' });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(before);
  });
});

describe.skipIf(process.platform === 'win32')('its card’s merge state (B9b C12)', () => {
  it('is observed again before a merge answers, merged or already merged, its lane free meanwhile', async () => {
    const refreshed = Promise.withResolvers<undefined>();
    const observe = vi.fn<(canvas: CanvasId, workspace: string) => Promise<void>>(
      () => refreshed.promise,
    );
    const w = await make({ deps: { observe } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    let answered = false;
    const going = w.service.merge(w.request()).then((result) => {
      answered = true;
      return result;
    });
    await vi.waitFor(
      () => {
        expect(observe).toHaveBeenCalledWith(CANVAS, w.tree.id);
      },
      { timeout: 60_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    // The repository's lane isn't held for it: the next job there runs.
    await w.queue.run(w.record.commonDir, () => Promise.resolve());
    refreshed.resolve(undefined);
    expect(merged(await going).outcome).toBe('merged');

    observe.mockClear();
    observe.mockResolvedValue(undefined);
    expect(merged(await w.service.merge(w.request())).outcome).toBe('already-merged');
    expect(observe).toHaveBeenCalledWith(CANVAS, w.tree.id);
  });

  it('is observed again after a refusal in the lane, never after one refused at admission', async () => {
    const observe = vi.fn<(canvas: CanvasId, workspace: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const w = await make({ deps: { observe } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const stale = w.request();
    w.work(w.app, { 'main.txt': 'main\n' });
    expect(refusal(await w.service.merge(stale)).code).toBe('conflict');
    expect(observe).toHaveBeenCalledWith(CANVAS, w.tree.id);

    observe.mockClear();
    w.writing.set('builder', 'has a turn going on');
    expect(refusal(await w.service.merge(w.request())).code).toBe('unavailable');
    expect(observe).not.toHaveBeenCalled();
  });

  it('never holds a merge’s answer past its bound', async () => {
    const w = await make({
      deps: { observe: () => new Promise<void>(() => undefined), observeWithinMs: 50 },
    });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    expect(merged(await w.service.merge(w.request())).outcome).toBe('merged');
  });

  it('says a merge goes on from its admission to its answer, and nothing once it is refused', async () => {
    const pause = pauseAt('admitted');
    const changed = vi.fn<(canvas: CanvasId) => void>();
    const w = await make({ deps: { fault: pause.fault, changed } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    const stale = w.request();
    w.work(w.app, { 'main.txt': 'main\n' });
    const going = w.service.merge(stale);
    await pause.reached;
    expect(changed).toHaveBeenCalledWith(CANVAS);
    expect(w.service.state(w.tree.id)).toEqual({ job: 'merging' });
    changed.mockClear();
    pause.resume();
    expect(refusal(await going).code).toBe('conflict');
    // Published again as it ended: no card is left saying it merges.
    expect(w.service.state(w.tree.id)).toBeUndefined();
    expect(changed).toHaveBeenCalledWith(CANVAS);
  });

  it('says a merge a restart couldn’t check is held, for you to see why: never merging forever', async () => {
    const crash = crashAt('recorded');
    const w = await make({ deps: { fault: crash.fault } });
    w.work(w.cwd, { 'agent.txt': 'agent\n' });
    void w.service.merge(w.request());
    await crash.reached;
    const changed = vi.fn<(canvas: CanvasId) => void>();
    const gone = mintTrustedPath(path.join(w.root, 'gone'));
    const service = w.restart({ pickedRoot: () => Promise.resolve(gone), changed });
    // Until the restart's reconciliation has looked, it is being finished.
    expect(service.state(w.tree.id)).toEqual({ job: 'merging' });
    await service.reconcile();
    expect(w.journal.latest(w.tree.id)).toMatchObject({ outcome: null });
    expect(service.state(w.tree.id)).toEqual({
      job: 'held',
      sentence: expect.stringMatching(/couldn’t check your checkout/) as unknown,
    });
    expect(changed).toHaveBeenCalledWith(CANVAS);
  });
});

describe('who asks', () => {
  it('is you, or a writing token by its id and name; never an agent', () => {
    expect(mergeCallerOf({ kind: 'human', window: 1 } as unknown as Caller)).toEqual({
      key: 'you',
      requester: 'you',
    });
    expect(
      mergeCallerOf({
        kind: 'outside',
        token: '0f1e2d3c-4b5a-4968-8776-655443322110',
        name: 'orchestrator',
        access: 'write',
        merge: true,
        canvases: [],
      }),
    ).toEqual({
      key: 'token:0f1e2d3c-4b5a-4968-8776-655443322110',
      requester: 'outside:orchestrator',
    });
    expect(() =>
      mergeCallerOf({ kind: 'agent', canvas: CANVAS, agent: 'a', session: 's' }),
    ).toThrow();
    expect(() =>
      mergeCallerOf({
        kind: 'outside',
        token: '0f1e2d3c-4b5a-4968-8776-655443322110',
        name: 'orchestrator',
        access: 'write',
        merge: false,
        canvases: [],
      }),
    ).toThrow();
  });
});

/** The digest Review changes shows of the agent's uncommitted work now. */
async function reviewDigest(w: MergeWorld): Promise<string> {
  const { inventoryUncommitted } = await import('./uncommitted');
  const inspected = await w.git.inspect(w.cwd);
  const read = await inventoryUncommitted(w.git, {
    cwd: w.cwd,
    tip: w.g(w.cwd, 'rev-parse', 'HEAD'),
    drivers: inspected.drivers,
    copied: [],
  });
  if (!read.ok || read.value.digest === null) throw new Error(JSON.stringify(read));
  return read.value.digest;
}
