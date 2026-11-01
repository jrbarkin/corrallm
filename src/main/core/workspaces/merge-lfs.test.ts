import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { differing, listing, ran } from './test-git';
import { mergeWorld } from './test-merge';
import type { MergeWorld } from './test-merge';

/*
 * A real Git LFS repository through the real merge service (B9b Design §9 C9b, C7's spot check):
 * a merge touching no LFS-tracked file lands, one touching an LFS-tracked file is refused with
 * nothing changed, and in neither does corrallm start an LFS filter. The filters are the real
 * git-lfs, run through a recording wrapper so "never invoked" is observed rather than assumed.
 * Needs git-lfs on the PATH: skipped cleanly where it isn't (CI images and the Docker gate may
 * not have it; the stand-in filter tests in merge.test.ts and merge-hostile.test.ts run everywhere).
 */

vi.setConfig({ testTimeout: 90_000 });

const lfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8' });
const available = lfs.status === 0 && lfs.stdout.startsWith('git-lfs/');

let world: MergeWorld | undefined;
afterEach(async () => {
  await world?.service.drained();
  await world?.close();
  world = undefined;
});

/**
 * Git status as you would run it, after the clock has passed the files' times: it refreshes what
 * the filters checked out (the stat data corrallm's filter-blanked, read-only status trusts).
 * Without it a file written in the same second as the index is "racily clean" and re-read raw.
 */
async function refreshed(w: MergeWorld, ...checkouts: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  for (const at of checkouts) w.g(at, 'status', '--porcelain');
}

/** A repository whose `*.bin` is LFS-tracked, its filters the real git-lfs through a recorder. */
async function lfsWorld(): Promise<{ w: MergeWorld; sentinel: string }> {
  const w = await mergeWorld({
    files: {
      'README.md': 'hello\n',
      '.gitignore': '*.log\n',
      '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    },
  });
  world = w;
  const real = spawnSync('sh', ['-c', 'command -v git-lfs'], { env: w.env, encoding: 'utf8' });
  const sentinel = path.join(w.root, 'lfs-ran');
  const wrapper = path.join(w.root, 'git-lfs-recorder');
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho "$*" >> '${sentinel}'\nexec '${real.stdout.trim()}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  // The real install (filters and hooks, in the repository's own configuration) ...
  w.g(w.app, 'lfs', 'install', '--local');
  // ... with each filter command going through the recorder.
  w.g(w.app, 'config', 'filter.lfs.clean', `${wrapper} clean -- %f`);
  w.g(w.app, 'config', 'filter.lfs.smudge', `${wrapper} smudge -- %f`);
  w.g(w.app, 'config', 'filter.lfs.process', `${wrapper} filter-process`);
  w.g(w.app, 'config', 'filter.lfs.required', 'true');
  return { w, sentinel };
}

describe.skipIf(process.platform === 'win32' || !available)('a Git LFS repository', () => {
  it('merges work touching no LFS file, and starts no LFS program doing it', async () => {
    const { w, sentinel } = await lfsWorld();
    // The agent adds an LFS file and a plain one; the merge is of a later commit touching only
    // plain files, after the LFS file is already in main's history.
    w.work(w.cwd, { 'asset.bin': 'binary payload\n' }, 'add an LFS file');
    expect(w.g(w.cwd, 'show', 'HEAD:asset.bin')).toMatch(/^version https:\/\/git-lfs/);
    expect(ran(sentinel)).not.toEqual([]); // the control: the real filter does run for plain Git
    // Land that commit by hand (the test's own Git, filters and all), then work again.
    w.g(w.app, 'merge', '--ff-only', w.tree.branchRef);
    await refreshed(w, w.app, w.cwd);
    expect(readFileSync(path.join(w.app, 'asset.bin'), 'utf8')).toBe('binary payload\n');
    const tip = w.work(w.cwd, { 'notes.txt': 'plain\n', 'docs/a.md': 'doc\n' }, 'plain work');
    writeFileSync(sentinel, '');

    const result = await w.service.merge(w.request());

    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    expect(result.value).toMatchObject({ outcome: 'merged', source: tip });
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(
      result.value.outcome === 'merged' ? result.value.mergeCommit : '',
    );
    expect(readFileSync(path.join(w.app, 'notes.txt'), 'utf8')).toBe('plain\n');
    expect(w.g(w.app, 'status', '--porcelain')).toBe('');
    expect(ran(sentinel)).toEqual([]);
  });

  it('refuses a merge touching an LFS-tracked file, naming it, nothing changed and no LFS program started', async () => {
    const { w, sentinel } = await lfsWorld();
    w.work(w.cwd, { 'asset.bin': 'binary payload\n', 'plain.txt': 'plain\n' }, 'LFS and plain');
    expect(w.g(w.cwd, 'show', 'HEAD:asset.bin')).toMatch(/^version https:\/\/git-lfs/);
    expect(ran(sentinel)).not.toEqual([]);
    await refreshed(w, w.cwd);
    writeFileSync(sentinel, '');
    const skip = (relative: string) => relative === path.join('.git', 'objects');
    const before = listing(w.app, skip);
    const main = w.g(w.app, 'rev-parse', 'main');

    const result = await w.service.merge(w.request());

    if (result.ok) throw new Error(`Merged: ${JSON.stringify(result.value)}`);
    expect(result.error.code).toBe('refused');
    expect(result.error.sentence).toMatch(/"asset\.bin"/);
    expect(differing(before, listing(w.app, skip))).toEqual([]);
    expect(w.g(w.app, 'rev-parse', 'main')).toBe(main);
    expect(existsSync(path.join(w.app, 'asset.bin'))).toBe(false);
    expect(w.g(w.app, 'status', '--porcelain')).toBe('');
    expect(ran(sentinel)).toEqual([]);
  });
});
