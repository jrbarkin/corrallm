import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it(
    'runs git with the repository’s fsmonitor off, whatever its config says',
    { timeout: 30_000 },
    async () => {
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
    },
  );

  it('says when the folder is not in a git repository', async () => {
    const git: RunGit = () => Promise.resolve({ code: 128, stdout: '' });
    await expect(gitDiff(git, '/work/app')).resolves.toBeUndefined();
  });
});

/*
 * A partial clone whose index names a blob it never fetched, and whose remote is a command its
 * configuration allows: a patch of that file would fetch the blob, and the fetch would run the
 * command. Real Git, in throwaway folders: the clone made once, its control run there, then
 * copied for each test, whose copy's remote records into that test's own sentinel.
 */
describe.skipIf(process.platform === 'win32')(
  '/diff in a partial clone',
  { timeout: 30_000 },
  () => {
    let template: string;
    let root: string;
    let env: Record<string, string> & { PATH: string };
    let clone: string;
    let sentinel: string;
    const environment = (home: string) => ({
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C',
    });
    const git = (cwd: string, e: Record<string, string>, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: e, encoding: 'utf8' });
    beforeAll(() => {
      template = realpathSync(mkdtempSync(path.join(tmpdir(), 'corrallm-git-')));
      const made = environment(template);
      const source = path.join(template, 'source');
      const ran = path.join(template, 'ran');
      const at = path.join(template, 'clone');
      mkdirSync(source);
      git(source, made, 'init', '-q');
      git(source, made, 'config', 'uploadpack.allowFilter', 'true');
      for (const text of ['one\n', 'two\n']) {
        writeFileSync(path.join(source, 'a.txt'), text);
        git(source, made, 'add', 'a.txt');
        git(source, made, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', text);
      }
      git(template, made, 'clone', '-q', '--filter=blob:none', `file://${source}`, at);
      // The index names a.txt's first blob, which the clone never fetched; the folder holds the
      // second.
      git(at, made, 'read-tree', 'HEAD~1');
      git(at, made, 'config', 'remote.origin.url', `ext::sh -c touch% ${ran}`);
      git(at, made, 'config', 'protocol.ext.allow', 'always');
      // The control: plain git fetches the blob to show the patch, running the remote's command
      // (whose fetch fails, so the blob stays missing for every copy).
      spawnSync('git', ['diff'], { cwd: at, env: made });
      expect(existsSync(ran)).toBe(true);
    }, 30_000);
    afterAll(() => {
      rmSync(template, { recursive: true, force: true });
    });
    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), 'corrallm-git-')));
      env = environment(root);
      sentinel = path.join(root, 'ran');
      clone = path.join(root, 'clone');
      cpSync(path.join(template, 'clone'), clone, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      git(clone, env, 'config', 'remote.origin.url', `ext::sh -c touch% ${sentinel}`);
    });
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

    it('allows no transport, including a remote helper named none', async () => {
      const real = execFileSync('sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim();
      const bin = path.join(root, 'bin');
      const used = path.join(root, 'used');
      mkdirSync(bin);
      // An installed helper is still a repository-chosen program. Simulate a Git predating
      // GIT_NO_LAZY_FETCH so the transport allowlist, rather than the newer flag, must stop it.
      writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\ntouch '${used}'\nunset GIT_NO_LAZY_FETCH\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(path.join(bin, 'git-remote-none'), `#!/bin/sh\ntouch '${sentinel}'\n`, {
        mode: 0o755,
      });
      execFileSync('git', ['config', 'remote.origin.url', 'none::somewhere'], { cwd: clone, env });
      await gitDiff(runGit({ ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }), clone);
      expect(existsSync(used)).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    });
  },
);
