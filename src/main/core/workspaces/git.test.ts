import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SAFE_GIT_OPTIONS } from '../../git';
import { Children } from '../children';
import { GitError, GitRunner, gitEnvironment as scrubbed } from './git';
import type { GitRunnerDeps } from './git';
import {
  commit,
  fakeGit,
  git,
  gitEnvironment,
  makeRepository,
  ran,
  scratch,
  sentinelProgram,
  templateRepository,
} from './test-git';
import type { RepositoryTemplate } from './test-git';

/*
 * The one runner every workspace Git call goes through (B9a Design §2, Git execution boundary):
 * fixed options that keep a repository's programs from running, a scrubbed environment, Git found
 * only on the PATH's absolute folders, bounded time and output, each git a child the core owns.
 * Real Git runs in throwaway repositories (a test's plain one a copy of one made once); a
 * stand-in git only where real Git can't be made to hang, print too much or be too old.
 */

// Real Git, a repository or two each: slower under load, or on Linux CI's emulated x64.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let template: RepositoryTemplate<string>;
let root: string;
let remove: () => void;
let home: string;
let hooks: string;
let env: Record<string, string>;

beforeAll(async () => {
  template = await templateRepository();
});
afterAll(() => {
  template.remove();
});
beforeEach(() => {
  ({ root, remove } = scratch());
  home = path.join(root, 'home');
  hooks = path.join(root, 'hooks');
  env = gitEnvironment(home);
});
afterEach(() => {
  remove();
});

function runner(deps: Partial<GitRunnerDeps> = {}): GitRunner {
  return new GitRunner({ environment: () => Promise.resolve(env), hooks, ...deps });
}

async function fault(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitError) return error.fault;
    throw error;
  }
  throw new Error('It ran.');
}

it('is the only workspace file that starts Git: every Git call goes through it, and only the setup runner starts anything else', () => {
  const folder = import.meta.dirname;
  const sources = readdirSync(folder).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.startsWith('test-'),
  );
  expect(sources).toContain('git.ts');
  // The setup runner starts only the setup command you allowed (setup-run.ts), never Git.
  expect(
    sources.filter((file) =>
      /child_process|sessions\/process|\bexecFile\(|\bspawn\(|\bfork\(|\bspawnOwned\(/.test(
        readFileSync(path.join(folder, file), 'utf8'),
      ),
    ),
  ).toEqual(['git.ts', 'setup-run.ts']);
  expect(readFileSync(path.join(folder, 'setup-run.ts'), 'utf8')).not.toMatch(/['"`]git['"`]/);
});

describe.skipIf(process.platform === 'win32')('GitRunner', () => {
  it('gives every git the options that keep a repository’s programs from running, then the call’s own', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, 'for a in "$@"; do printf "%s\\0" "$a"; done');
    const { stdout } = await runner({ executable: stand }).run({
      cwd: root,
      args: ['status'],
      drivers: ['lfs', 'odd.name'],
      // A call's own configuration comes first: the fixed options after it win.
      config: ['core.trustctime=true', 'core.hooksPath=/elsewhere'],
    });
    expect(stdout.split('\0').slice(0, -1)).toEqual([
      '-c',
      'core.trustctime=true',
      '-c',
      'core.hooksPath=/elsewhere',
      ...SAFE_GIT_OPTIONS,
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'submodule.recurse=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'worktree.useRelativePaths=false',
      ...['lfs', 'odd.name'].flatMap((driver) => [
        '-c',
        `filter.${driver}.clean=`,
        '-c',
        `filter.${driver}.smudge=`,
        '-c',
        `filter.${driver}.process=`,
        '-c',
        `filter.${driver}.required=false`,
      ]),
      'status',
    ]);
    // Its hooks folder is empty, the core's own.
    expect(readdirSync(hooks)).toEqual([]);
  });

  it('refuses a driver it can’t name with -c, before running anything', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, `echo ran >> '${path.join(root, 'ran')}'`);
    expect(
      await fault(
        runner({ executable: stand }).run({ cwd: root, args: ['status'], drivers: ['x=y'] }),
      ),
    ).toBe('config');
    expect(ran(path.join(root, 'ran'))).toEqual([]);
  });

  it('scrubs Git’s own variables from the environment, keeping the user’s home and PATH', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, 'env');
    env = {
      ...env,
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/index',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/evil'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/evil',
      GIT_CONFIG_GLOBAL: '/evil/config',
      GIT_EXEC_PATH: '/evil/libexec',
      GIT_EXTERNAL_DIFF: '/evil/diff',
      GIT_SSH_COMMAND: '/evil/ssh',
      GIT_GRAFT_FILE: '/elsewhere/grafts',
      Git_Dir: '/elsewhere/.git',
    };
    const { stdout } = await runner({ executable: stand }).run({ cwd: root, args: ['status'] });
    const seen = Object.fromEntries(
      stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    expect(
      Object.keys(seen)
        .filter((key) => /^git_/i.test(key))
        .sort(),
    ).toEqual(['GIT_ALLOW_PROTOCOL', 'GIT_GRAFT_FILE', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT']);
    expect(seen).toMatchObject({
      GIT_ALLOW_PROTOCOL: '',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_GRAFT_FILE: path.join(process.execPath, 'no-grafts'),
      LC_ALL: 'C',
      HOME: home,
      PATH: env.PATH,
    });
    expect(scrubbed({ GIT_DIR: 'x', PATH: 'p', UNSET: undefined })).toEqual({
      PATH: 'p',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '',
      GIT_GRAFT_FILE: path.join(process.execPath, 'no-grafts'),
      LC_ALL: 'C',
    });
  });

  it('works in the folder it is given, whatever the environment redirects, and runs none of what it sets', async () => {
    const sentinel = path.join(root, 'ran');
    const program = sentinelProgram(root, sentinel);
    const here = path.join(root, 'here');
    const elsewhere = path.join(root, 'elsewhere');
    const oid = template.copy(here, env);
    makeRepository(elsewhere, env, { 'other.md': 'other\n' });
    const evil = path.join(root, 'evil-hooks');
    mkdirSync(evil);
    writeFileSync(path.join(evil, 'reference-transaction'), `#!/bin/sh\n'${program}'\n`, {
      mode: 0o755,
    });
    env = {
      ...env,
      GIT_DIR: path.join(elsewhere, '.git'),
      GIT_WORK_TREE: elsewhere,
      GIT_CONFIG_PARAMETERS: `'core.hookspath'='${evil}'`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: program,
    };
    const git2 = runner();
    const top = await git2.run({ cwd: here, args: ['rev-parse', '--show-toplevel'] });
    expect(top.stdout.trim()).toBe(here);
    await git2.run({ cwd: here, args: ['update-ref', 'refs/heads/made', oid, ''] });
    await git2.run({ cwd: here, args: ['status', '--porcelain'] });
    const clean = gitEnvironment(home);
    expect(git(here, clean, 'rev-parse', 'refs/heads/made').trim()).toBe(oid);
    expect(() => git(elsewhere, clean, 'rev-parse', '--verify', 'refs/heads/made')).toThrow();
    expect(ran(sentinel)).toEqual([]);
  });

  it('runs no repository hook, wherever its configuration puts them', async () => {
    const sentinel = path.join(root, 'ran');
    const program = sentinelProgram(root, sentinel);
    const here = path.join(root, 'here');
    const oid = template.copy(here, env);
    const hook = `#!/bin/sh\n'${program}' "$@"\n`;
    for (const name of ['reference-transaction', 'post-index-change', 'post-checkout']) {
      writeFileSync(path.join(here, '.git', 'hooks', name), hook, { mode: 0o755 });
    }
    const configured = path.join(root, 'configured-hooks');
    mkdirSync(configured);
    writeFileSync(path.join(configured, 'reference-transaction'), hook, { mode: 0o755 });
    git(here, env, 'update-ref', 'refs/heads/control', oid, '');
    // The control: Git runs the repository's own hook when nothing stops it.
    expect(ran(sentinel).length).toBeGreaterThan(0);
    writeFileSync(sentinel, '');
    const git2 = runner();
    await git2.run({ cwd: here, args: ['update-ref', 'refs/heads/one', oid, ''] });
    git(here, env, 'config', 'core.hooksPath', configured);
    await git2.run({ cwd: here, args: ['update-ref', 'refs/heads/two', oid, ''] });
    expect(ran(sentinel)).toEqual([]);
  });

  it('uses no transport, whatever protocols the repository allows', async () => {
    const sentinel = path.join(root, 'ran');
    const here = path.join(root, 'here');
    template.copy(here, env);
    // protocol.<name>.allow outranks protocol.allow, whichever configuration sets either.
    git(here, env, 'config', 'protocol.ext.allow', 'always');
    git(here, env, 'config', 'protocol.file.allow', 'always');
    const other = path.join(root, 'other');
    makeRepository(other, env, { 'other.md': 'other\n' });
    const git2 = runner();
    expect(
      await fault(git2.run({ cwd: here, args: ['fetch', `ext::sh -c touch% ${sentinel}`] })),
    ).toBe('failed');
    expect(
      await fault(git2.run({ cwd: here, args: ['fetch', `file://${other}`, 'main:theirs'] })),
    ).toBe('failed');
    expect(existsSync(sentinel)).toBe(false);
    expect(() => git(here, env, 'rev-parse', '--verify', 'refs/heads/theirs')).toThrow();
  });

  it('runs no promisor remote’s command populating a partial clone, on a Git without GIT_NO_LAZY_FETCH', async () => {
    const sentinel = path.join(root, 'ran');
    const source = path.join(root, 'source');
    makeRepository(source, env, { 'a.txt': 'hello\n' });
    git(source, env, 'config', 'uploadpack.allowFilter', 'true');
    const clone = path.join(root, 'clone');
    git(
      root,
      env,
      '-c',
      'protocol.file.allow=always',
      'clone',
      '-q',
      '--no-checkout',
      '--filter=blob:none',
      `file://${source}`,
      clone,
    );
    git(clone, env, 'config', 'remote.origin.url', `ext::sh -c touch% ${sentinel}`);
    git(clone, env, 'config', 'protocol.ext.allow', 'always');
    const oid = git(clone, env, 'rev-parse', 'HEAD').trim();
    // Git before 2.45.1 (and its 2.39.4+ backports) doesn't know GIT_NO_LAZY_FETCH.
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const older = path.join(dir, 'older-git');
    writeFileSync(older, '#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec git "$@"\n', { mode: 0o755 });
    expect(
      await fault(
        runner({ executable: older }).run({
          cwd: clone,
          args: ['read-tree', '--reset', '-u', '--no-recurse-submodules', oid],
        }),
      ),
    ).toBe('failed');
    expect(existsSync(sentinel)).toBe(false);
  });

  it('refuses to run while its hooks folder holds anything, or isn’t a folder of its own', async () => {
    const here = path.join(root, 'here');
    template.copy(here, env);
    const git2 = runner();
    await git2.run({ cwd: here, args: ['status'] });
    writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\n', { mode: 0o755 });
    expect(await fault(git2.run({ cwd: here, args: ['status'] }))).toBe('hooks');
    const other = path.join(root, 'other-hooks');
    mkdirSync(other);
    hooks = path.join(root, 'linked-hooks');
    symlinkSync(other, hooks);
    expect(await fault(runner().run({ cwd: here, args: ['status'] }))).toBe('hooks');
  });

  it('finds git only in the PATH’s absolute folders, never one a repository plants', async () => {
    const sentinel = path.join(root, 'ran');
    const here = path.join(root, 'here');
    template.copy(here, env);
    writeFileSync(path.join(here, 'git'), `#!/bin/sh\necho planted >> '${sentinel}'\n`, {
      mode: 0o755,
    });
    env = { ...env, PATH: `.:bin:${env.PATH ?? ''}` };
    const top = await runner().run({ cwd: here, args: ['rev-parse', '--show-toplevel'] });
    expect(top.stdout.trim()).toBe(here);
    expect(ran(sentinel)).toEqual([]);
    env = { ...env, PATH: `.:${path.join(root, 'nothing')}` };
    expect(await fault(runner().run({ cwd: here, args: ['status'] }))).toBe('git-missing');
  });

  it('refuses a Git older than the oldest it supports', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const old = path.join(dir, 'git');
    writeFileSync(old, '#!/bin/sh\necho "git version 2.35.8"\n', { mode: 0o755 });
    expect(await fault(runner({ executable: old }).run({ cwd: root, args: ['status'] }))).toBe(
      'git-unsupported',
    );
  });

  it('answers with the exit codes a call expects, and fails others with Git’s words, bounded', async () => {
    const here = path.join(root, 'here');
    template.copy(here, env);
    const git2 = runner();
    const none = await git2.run({
      cwd: here,
      args: ['symbolic-ref', '--quiet', 'refs/heads/none'],
      answers: [1],
    });
    expect(none.code).toBe(1);
    const error = await git2.run({ cwd: here, args: ['rev-parse', '--verify', 'nothing'] }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ fault: 'failed', exitCode: 128 });
    expect((error as GitError).stderr).toMatch(/fatal/);
    expect((error as GitError).stderr.length).toBeLessThanOrEqual(2000);
  });

  it('ends a git that takes too long, with its whole process group', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const pids = path.join(root, 'pids');
    const stand = fakeGit(dir, `sleep 30 & echo $! > '${pids}'; wait`);
    const children = new Children(path.join(root, 'profile'));
    await children.recover();
    const started = Date.now();
    expect(
      await fault(
        runner({ executable: stand, processes: children }).run({
          cwd: root,
          args: ['status'],
          timeoutMs: 300,
        }),
      ),
    ).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
    await children.flush();
    const grandchild = Number(readFileSync(pids, 'utf8'));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('stops reading at its bound', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, 'head -c 2000000 /dev/zero');
    expect(
      await fault(
        runner({ executable: stand }).run({ cwd: root, args: ['status'], maxBytes: 65_536 }),
      ),
    ).toBe('output');
  });

  it('records each git as the core’s child while it runs, and starts none once the core closes', async () => {
    const dir = path.join(root, 'bin');
    mkdirSync(dir);
    const stand = fakeGit(dir, 'sleep 0.5; echo done');
    const profile = path.join(root, 'profile');
    const children = new Children(profile);
    await children.recover();
    const file = path.join(profile, 'sessions', 'pids.json');
    const owned = runner({ executable: stand, processes: children });
    // Its version is asked once, first, also as an owned child.
    await owned.run({ cwd: root, args: ['status'] });
    const running = owned.run({ cwd: root, args: ['status'] });
    let recorded: unknown[] = [];
    for (let i = 0; i < 100 && recorded.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      recorded = (JSON.parse(readFileSync(file, 'utf8')) as { children: unknown[] }).children;
    }
    expect(recorded).toHaveLength(1);
    expect((await running).stdout.trim()).toBe('done');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, children: [] });
    await children.close();
    expect(
      await fault(
        runner({ executable: stand, processes: children }).run({ cwd: root, args: ['status'] }),
      ),
    ).toBe('refused');
  });

  describe('inspect', () => {
    it('names every filter driver configured where the call runs, conditional includes as they apply there', async () => {
      const here = path.join(root, 'here');
      template.copy(here, env);
      git(here, env, 'config', 'filter.lfs.process', 'git-lfs filter-process');
      git(here, env, 'config', 'filter.lfs.required', 'true');
      git(here, env, 'config', 'filter.Other.Name.smudge', 'other');
      const late = path.join(root, 'late.config');
      writeFileSync(late, '[filter "late"]\n\tsmudge = late\n');
      git(here, env, 'config', 'includeIf.onbranch:feature/**.path', late);
      const git2 = runner();
      expect(await git2.inspect(here)).toEqual({
        drivers: ['Other.Name', 'lfs'],
        mergeDrivers: [],
        refusals: [],
      });
      git(here, env, 'checkout', '-q', '-b', 'feature/x');
      expect((await git2.inspect(here)).drivers).toEqual(['Other.Name', 'late', 'lfs']);
    });

    it('says what it can’t neutralize: a driver -c can’t name, a redirected checkout, configured hooks', async () => {
      const here = path.join(root, 'here');
      template.copy(here, env);
      git(here, env, 'config', 'filter.x=y.clean', 'evil');
      git(here, env, 'config', 'core.worktree', '/elsewhere');
      git(here, env, 'config', 'hook.audit.command', 'evil');
      const { refusals } = await runner().inspect(here);
      expect(refusals).toHaveLength(3);
      expect(refusals.join(' ')).toMatch(/x=y/);
      expect(refusals.join(' ')).toMatch(/core\.worktree/);
      expect(refusals.join(' ')).toMatch(/hook/);
    });
  });

  describe('patch', () => {
    it('runs no external diff, textconv or filter driver', async () => {
      const sentinel = path.join(root, 'ran');
      const program = sentinelProgram(root, sentinel);
      const here = path.join(root, 'here');
      makeRepository(here, env, {
        '.gitattributes': '*.txt diff=evil filter=evil\n',
        'a.txt': 'one\n',
      });
      git(here, env, 'config', 'diff.external', program);
      git(here, env, 'config', 'diff.evil.textconv', program);
      git(here, env, 'config', 'diff.evil.command', program);
      git(here, env, 'config', 'filter.evil.clean', program);
      git(here, env, 'config', 'filter.evil.process', program);
      writeFileSync(path.join(here, 'a.txt'), 'two\n');
      git(here, gitEnvironment(home), 'add', '-A');
      writeFileSync(sentinel, '');
      // The control: Git runs the repository's diff program when nothing stops it.
      git(here, env, 'diff', 'HEAD');
      expect(ran(sentinel).length).toBeGreaterThan(0);
      // The test's own commit refreshes the index through the filter too.
      commit(here, gitEnvironment(home), 'second');
      writeFileSync(path.join(here, 'a.txt'), 'three\n');
      writeFileSync(sentinel, '');
      const git2 = runner();
      const { drivers } = await git2.inspect(here);
      const diff = await git2.patch({ cwd: here, command: 'diff', args: [], drivers });
      const log = await git2.patch({ cwd: here, command: 'log', args: ['-p', '-1'], drivers });
      expect(diff.stdout).toMatch(/^-two\n\+three$/m);
      expect(log.stdout).toMatch(/^\+two$/m);
      expect(ran(sentinel)).toEqual([]);
    });

    it('runs no signature program, whatever log.showSignature says', async () => {
      const sentinel = path.join(root, 'ran');
      const program = sentinelProgram(root, sentinel);
      const here = path.join(root, 'here');
      template.copy(here, env);
      // A commit carrying a signature header, as a signed one does (it needn't be valid).
      const tree = git(here, env, 'rev-parse', 'HEAD^{tree}').trim();
      const parent = git(here, env, 'rev-parse', 'HEAD').trim();
      const body = [
        `tree ${tree}`,
        `parent ${parent}`,
        'author Test <test@example.invalid> 1 +0000',
        'committer Test <test@example.invalid> 1 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' ',
        ' x',
        ' -----END PGP SIGNATURE-----',
        '',
        'signed',
        '',
      ].join('\n');
      const file = path.join(root, 'commit');
      writeFileSync(file, body);
      const signed = git(here, env, 'hash-object', '-t', 'commit', '-w', file).trim();
      git(here, env, 'update-ref', 'refs/heads/main', signed);
      git(here, env, 'config', 'log.showSignature', 'true');
      git(here, env, 'config', 'gpg.program', program);
      // The control: Git runs the repository's signature program when nothing stops it.
      git(here, env, 'log', '-1');
      expect(ran(sentinel).length).toBeGreaterThan(0);
      writeFileSync(sentinel, '');
      const git2 = runner();
      await git2.patch({ cwd: here, command: 'log', args: ['-p', '-1'] });
      await git2.patch({ cwd: here, command: 'show', args: [] });
      expect(ran(sentinel)).toEqual([]);
    });

    it('takes its paths literally, takes no lock, and reads capped when asked (B9b §9 C2)', async () => {
      const here = path.join(root, 'here');
      makeRepository(here, env, { '*': 'star\n', a: 'aaa\n', 'b.txt': 'bbb\n' });
      writeFileSync(path.join(here, '*'), 'star, changed\n');
      writeFileSync(path.join(here, 'a'), 'aaa, changed\n');
      // Stat-dirty, same bytes: a plain diff would refresh the index, rewriting it.
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(path.join(here, 'b.txt'), old, old);
      const index = path.join(here, '.git', 'index');
      const before = readFileSync(index);
      const git2 = runner();
      const { drivers } = await git2.inspect(here);
      const literal = await git2.patch({
        cwd: here,
        command: 'diff',
        args: ['HEAD', '--', '*'],
        drivers,
      });
      // `*` is the file of that name, not a glob over every other.
      expect(literal.stdout).toMatch(/^\+star, changed$/m);
      expect(literal.stdout).not.toMatch(/aaa/);
      expect(readFileSync(index)).toEqual(before);
      writeFileSync(path.join(here, 'a'), 'x\n'.repeat(50_000));
      const capped = await git2.patch({
        cwd: here,
        command: 'diff',
        args: ['HEAD', '--', 'a'],
        drivers,
        cap: 4_096,
      });
      expect(capped).toMatchObject({ cut: true, code: null });
      expect(Buffer.byteLength(capped.stdout)).toBeLessThanOrEqual(4_096);
      expect(capped.stdout).toMatch(/^diff --git a\/a b\/a\n/);
      const whole = await git2.patch({
        cwd: here,
        command: 'diff',
        args: ['HEAD', '--', '*'],
        drivers,
        cap: 4_096,
      });
      expect(whole).toMatchObject({ cut: false, code: 0, stdout: literal.stdout });
      expect(readFileSync(index)).toEqual(before);
    });

    it('runs nothing a submodule’s own configuration names', async () => {
      const sentinel = path.join(root, 'ran');
      const program = sentinelProgram(root, sentinel);
      const sub = path.join(root, 'sub');
      makeRepository(sub, env, { '.gitattributes': '*.txt filter=inner\n', 's.txt': 'aaa\n' });
      const here = path.join(root, 'here');
      template.copy(here, env);
      git(here, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
      // A committed .gitmodules can ask for a submodule's changes to be looked at in full.
      git(here, env, 'config', '-f', '.gitmodules', 'submodule.sub.ignore', 'none');
      git(here, env, 'add', '.gitmodules');
      commit(here, env, 'sub');
      const inner = path.join(here, 'sub');
      git(inner, env, 'config', 'filter.inner.clean', program);
      git(inner, env, 'config', 'diff.external', program);
      git(here, env, 'config', 'diff.submodule', 'diff');
      // Its file changed, at its size: only its filter can say whether it differs.
      writeFileSync(path.join(inner, 's.txt'), 'bbb\n');
      // The control: Git asks the submodule, which runs its programs, when nothing stops it.
      git(here, env, '-c', 'core.hooksPath=/dev/null', 'diff');
      expect(ran(sentinel).length).toBeGreaterThan(0);
      writeFileSync(sentinel, '');
      const git2 = runner();
      const { drivers } = await git2.inspect(here);
      await git2.patch({ cwd: here, command: 'diff', args: [], drivers });
      await git2.patch({ cwd: here, command: 'log', args: ['-p', '-1'], drivers });
      expect(ran(sentinel)).toEqual([]);
    });
  });
});
