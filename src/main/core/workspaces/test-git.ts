import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * Real Git, for the workspaces' tests: throwaway repositories in throwaway folders, never the
 * user's, with no user or system configuration (a home of the test's own), and programs that only
 * record that they ran (sentinels), so a test can assert that a repository's hooks, filters and
 * drivers never did.
 */

/** A throwaway folder, by its real path (the system's temporary folder may be a symlink's). */
export function scratch(prefix = 'corrallm-git-'): { root: string; remove: () => void } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return {
    root,
    remove: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The environment of a test's git: its own home, so none of the user's configuration applies. */
export function gitEnvironment(home: string): Record<string, string> {
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

/** Runs git for a test's own setup and checks (never through the runner under test). */
export function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository at `at` on main (`init` adding to its `git init`), its files committed once: its commit. */
export function makeRepository(
  at: string,
  env: Record<string, string>,
  files: Record<string, string> = { 'README.md': 'hello\n' },
  init: readonly string[] = [],
): string {
  mkdirSync(at, { recursive: true });
  git(at, env, 'init', '-q', '-b', 'main', ...init);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
    writeFileSync(path.join(at, file), text);
  }
  git(at, env, 'add', '-A');
  commit(at, env, 'first');
  return git(at, env, 'rev-parse', 'HEAD').trim();
}

/**
 * A repository made once for a describe's (or a file's) tests, each test given a copy of its own:
 * the folder copied instead of the git runs that made it. What a test writes in its copy never
 * reaches the template or another test's copy. A copy keeps every object, ref, file, mode and
 * time, so its commits are the template's; its index is refreshed for the copy's own files (new
 * inodes), as Git would have written it there. Programs a test configures (sentinels) belong in
 * its copy, after copying, so that what records a run is the test's own.
 */
export interface RepositoryTemplate<T> {
  /** What making it answered (its commits, say): each copy's too. */
  readonly made: T;
  /**
   * A copy at `at` (which must not exist yet, or be an empty folder: a submodule's in a checkout,
   * say), its index refreshed with the test's `env`.
   */
  copy(at: string, env: Record<string, string>): T;
  /** Deletes the template: an afterAll's. */
  remove(): void;
}

/**
 * Makes a template with `make`: in a throwaway folder (`root`) of its own, the repository at
 * `at`, with git's `env` of its own home.
 */
export async function repositoryTemplate<T>(
  make: (at: string, env: Record<string, string>, root: string) => T | Promise<T>,
): Promise<RepositoryTemplate<T>> {
  const { root, remove } = scratch('corrallm-template-');
  try {
    const env = gitEnvironment(path.join(root, 'home'));
    const at = path.join(root, 'repository');
    const made = await make(at, env, root);
    return {
      made,
      copy: (to, testEnv) => {
        if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`${to} isn’t empty.`);
        cpSync(at, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        git(to, testEnv, 'update-index', '-q', '--refresh');
        return made;
      },
      remove,
    };
  } catch (error) {
    remove();
    throw error;
  }
}

/** `makeRepository`'s repository (its files committed once) as a template: its commit. */
export function templateRepository(
  files: Record<string, string> = { 'README.md': 'hello\n' },
  init: readonly string[] = [],
): Promise<RepositoryTemplate<string>> {
  return repositoryTemplate((at, env) => makeRepository(at, env, files, init));
}

/** Commits what is staged, as a test author. */
export function commit(at: string, env: Record<string, string>, message: string): void {
  git(
    at,
    env,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    message,
  );
}

/** A program that only records each run (its arguments) in `sentinel`, passing its input through. */
export function sentinelProgram(dir: string, sentinel: string, name = 'sentinel.sh'): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "$0 $*" >> '${sentinel}'\ncat\n`, { mode: 0o755 });
  return file;
}

/** What the sentinel recorded: none if nothing ran. */
export function ran(sentinel: string): string[] {
  return existsSync(sentinel) ? readFileSync(sentinel, 'utf8').split('\n').filter(Boolean) : [];
}

/** A stand-in git (a shell script) for what real Git can't be made to do on demand. */
export function fakeGit(dir: string, script: string): string {
  const file = path.join(dir, 'git');
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.50.1"; exit 0; fi\n${script}\n`,
    { mode: 0o755 },
  );
  return file;
}

/** Every hook Git knows, by name: a repository's own, in whichever folder it keeps them. */
export const HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
];

/** Puts in `dir` a hook of every name Git knows, each running `program` with its name. */
export function hooksInto(dir: string, program: string): void {
  mkdirSync(dir, { recursive: true });
  for (const hook of HOOKS) {
    writeFileSync(path.join(dir, hook), `#!/bin/sh\n'${program}' hook ${hook} "$@"\nexit 0\n`, {
      mode: 0o755,
    });
  }
}

/**
 * Every path under `at` (links never followed), each as what it is: a folder, a link by its
 * target, or a file by its inode and its content's hash, so a file written again shows even with
 * the same content. Paths `skip` names are left out, with what is below them.
 */
export function listing(
  at: string,
  skip: (relative: string) => boolean = () => false,
): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(path.join(at, relative)).sort()) {
      const inner = relative === '' ? name : path.join(relative, name);
      if (skip(inner)) continue;
      const full = path.join(at, inner);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) found[inner] = `-> ${readlinkSync(full)}`;
      else if (stats.isDirectory()) {
        found[inner] = '/';
        walk(inner);
      } else {
        const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        found[inner] = `${String(stats.ino)} ${hash}`;
      }
    }
  };
  walk('');
  return found;
}

/** The paths two listings differ at: added, removed, or changed. */
export function differing(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((at) => before[at] !== after[at]).sort();
}

/**
 * Whether the Git these tests run supports what `args` ask of its `init` (a ref or object format,
 * say), probed by asking it: a feature an older Git lacks is skipped by what it can do, never by
 * its version's number.
 */
export function gitInits(...args: string[]): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'corrallm-git-probe-'));
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: probe, GIT_CONFIG_NOSYSTEM: '1' };
    const made = spawnSync('git', ['init', '-q', ...args, path.join(probe, 'r')], {
      stdio: 'ignore',
      env,
    });
    return made.status === 0;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** Whether the system's temporary folder tells names apart by case only (Linux) or not (macOS). */
export function caseInsensitive(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'corrallm-case-probe-'));
  try {
    writeFileSync(path.join(probe, 'Case'), '');
    return existsSync(path.join(probe, 'case'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
