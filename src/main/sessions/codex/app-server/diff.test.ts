import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('says when the folder is not in a git repository', async () => {
    const git: RunGit = () => Promise.resolve({ code: 128, stdout: '' });
    await expect(gitDiff(git, '/work/app')).resolves.toBeUndefined();
  });
});

/*
 * A partial clone whose index names a blob it never fetched, and whose remote is a command its
 * configuration allows: a patch of that file would fetch the blob, and the fetch would run the
 * command. Real Git, in a throwaway folder.
 */
describe.skipIf(process.platform === 'win32')(
  '/diff in a partial clone',
  { timeout: 30_000 },
  () => {
    let root: string;
    let env: Record<string, string> & { PATH: string };
    let clone: string;
    let sentinel: string;
    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), 'corrallm-git-')));
      env = { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
      sentinel = path.join(root, 'ran');
      const source = path.join(root, 'source');
      clone = path.join(root, 'clone');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, env, encoding: 'utf8' });
      mkdirSync(source);
      git(source, 'init', '-q');
      git(source, 'config', 'uploadpack.allowFilter', 'true');
      for (const text of ['one\n', 'two\n']) {
        writeFileSync(path.join(source, 'a.txt'), text);
        git(source, 'add', 'a.txt');
        git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', text);
      }
      git(root, 'clone', '-q', '--filter=blob:none', `file://${source}`, clone);
      // The index names a.txt's first blob, which the clone never fetched; the folder holds the
      // second.
      git(clone, 'read-tree', 'HEAD~1');
      git(clone, 'config', 'remote.origin.url', `ext::sh -c touch% ${sentinel}`);
      git(clone, 'config', 'protocol.ext.allow', 'always');
      // The control: plain git fetches the blob to show the patch, running the remote's command.
      spawnSync('git', ['diff'], { cwd: clone, env });
      expect(existsSync(sentinel)).toBe(true);
      rmSync(sentinel);
    }, 30_000);
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('runs no command the clone’s remote names', async () => {
      await gitDiff(runGit(env), clone);
      expect(existsSync(sentinel)).toBe(false);
    });

    it('runs none on a Git that doesn’t know GIT_NO_LAZY_FETCH either', async () => {
      // Git before 2.45.1 (and its 2.39.4+ backports) ignores it.
      const real = execFileSync('sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim();
      const bin = path.join(root, 'bin');
      const used = path.join(root, 'used');
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\ntouch '${used}'\nunset GIT_NO_LAZY_FETCH\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      );
      await gitDiff(runGit({ ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }), clone);
      expect(existsSync(used)).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    });
  },
);
