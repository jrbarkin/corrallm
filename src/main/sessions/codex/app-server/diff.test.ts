import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { gitDiff, runGit, splitDiff } from './diff';
import type { RunGit } from './diff';

const TRACKED = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe('/diff', () => {
  it('splits a diff into each file’s patch, named by its path', () => {
    expect(splitDiff(TRACKED).map((file) => file.path)).toEqual(['src/a.ts', 'gone.txt']);
    expect(splitDiff(TRACKED)[0]?.patch).toMatch(/^diff --git a\/src\/a\.ts.*\n\+new$/s);
    expect(splitDiff('')).toEqual([]);
  });

  it('asks git for unstaged changes and untracked files, keeping the repository from running anything', async () => {
    const git = vi.fn<RunGit>((args) => {
      const [command] = args.filter((arg) => !arg.includes('=') && arg !== '-c');
      switch (command) {
        case 'rev-parse':
          return Promise.resolve({ code: 0, stdout: 'true\n' });
        case 'config':
          return Promise.resolve({ code: 0, stdout: 'filter.lfs.clean\0filter.lfs.process\0' });
        case 'ls-files':
          return Promise.resolve({ code: 0, stdout: 'new.txt\0' });
        default:
          return Promise.resolve(
            args.includes('--no-index')
              ? {
                  code: 1,
                  stdout:
                    'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n',
                }
              : { code: 0, stdout: TRACKED },
          );
      }
    });
    const files = await gitDiff(git, '/work/app', 'darwin');
    expect(files?.map((file) => file.path)).toEqual(['src/a.ts', 'gone.txt', 'new.txt']);
    const diffs = git.mock.calls.map(([args]) => args).filter((args) => args.includes('diff'));
    for (const args of diffs) {
      // The repository's filter drivers, external diffs and textconv do not run.
      expect(args).toEqual(
        expect.arrayContaining([
          '-c',
          'filter.lfs.clean=',
          'filter.lfs.process=',
          'filter.lfs.required=false',
          '--no-ext-diff',
          '--no-textconv',
        ]),
      );
    }
    expect(diffs.at(-1)?.slice(-3)).toEqual(['--', '/dev/null', 'new.txt']);
  });

  it('runs git with the repository’s fsmonitor off, whatever its config says', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'core.fsmonitor', 'touch pwned'], { cwd: dir });
      const git = runGit({ PATH: process.env.PATH ?? '' });
      await expect(git(['config', 'core.fsmonitor'], dir)).resolves.toEqual({
        code: 0,
        stdout: 'false\n',
      });
      await expect(gitDiff(git, dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'runs git with lazy fetch off, whatever the agents’ environment says',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-git-'));
      try {
        const git = runGit({ PATH: process.env.PATH ?? '', GIT_NO_LAZY_FETCH: '0' });
        await expect(
          git(['-c', 'alias.lazy=!printenv GIT_NO_LAZY_FETCH', 'lazy'], dir),
        ).resolves.toEqual({ code: 0, stdout: '1\n' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('says when the folder is not in a git repository', async () => {
    const git: RunGit = () => Promise.resolve({ code: 128, stdout: '' });
    await expect(gitDiff(git, '/work/app')).resolves.toBeUndefined();
  });
});
