import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

/** A repository at `at` on main, its files committed once: its commit. */
export function makeRepository(
  at: string,
  env: Record<string, string>,
  files: Record<string, string> = { 'README.md': 'hello\n' },
): string {
  mkdirSync(at, { recursive: true });
  git(at, env, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
    writeFileSync(path.join(at, file), text);
  }
  git(at, env, 'add', '-A');
  commit(at, env, 'first');
  return git(at, env, 'rev-parse', 'HEAD').trim();
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
