import { execFile } from 'node:child_process';

import { SAFE_GIT_OPTIONS } from '../../../git';

/*
 * /diff, as Codex's TUI does it (codex-rs/tui/src/get_git_diff.rs, rust-v0.160.1): git's diff of
 * the project folder's changes not yet staged, then its untracked files, each file's on its own.
 * Main runs git itself, with arguments of its own (nothing the renderer sent is on its command
 * line), and, as the TUI does, keeps the repository's configuration from running anything:
 * no fsmonitor, no external diff or textconv, no filter drivers.
 */

/** A file's changes: its path (as git names it, relative to the repository) and its patch. */
export interface FileDiff {
  path: string;
  patch: string;
}

/** Runs git in `cwd`: what it printed, and its exit code (git diff --no-index exits 1 on a difference). */
export type RunGit = (
  args: readonly string[],
  cwd: string,
) => Promise<{ code: number; stdout: string }>;

const GIT_MS = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;
/** At most this many untracked files are shown. */
const MAX_UNTRACKED = 100;
const DIFF = [
  'diff',
  '--no-color',
  '--no-textconv',
  '--no-ext-diff',
  '--submodule=short',
  '--ignore-submodules=dirty',
];

/** Runs git with the agents' environment. */
export function runGit(env: Readonly<Record<string, string>>): RunGit {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        [...SAFE_GIT_OPTIONS, ...args],
        { cwd, env, timeout: GIT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (error, stdout) => {
          if (!error) resolve({ code: 0, stdout });
          else if (typeof error.code === 'number') resolve({ code: error.code, stdout });
          else reject(new Error(`git ${args.join(' ')} failed`, { cause: error }));
        },
      );
    });
}

/**
 * The project folder's changes, file by file: what changed and is not staged, then the untracked
 * files. Undefined if the folder is not in a git repository.
 */
export async function gitDiff(
  git: RunGit,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<FileDiff[] | undefined> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd).catch(() => undefined);
  if (inside?.code !== 0 || inside.stdout.trim() !== 'true') return undefined;
  // Filter drivers (a repository's clean and process commands) would run on the files diffed.
  const filters = await git(
    ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
    cwd,
  );
  const drivers = new Set(
    filters.stdout.split('\0').flatMap((key) => /^(.*)\.(?:clean|process)$/.exec(key)?.[1] ?? []),
  );
  const off = [...drivers].flatMap((driver) => [
    '-c',
    `${driver}.clean=`,
    '-c',
    `${driver}.process=`,
    '-c',
    `${driver}.required=false`,
  ]);
  const tracked = (await git([...off, ...DIFF], cwd)).stdout;
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)).stdout
    .split('\0')
    .filter((file) => file !== '')
    .slice(0, MAX_UNTRACKED);
  const nothing = platform === 'win32' ? 'NUL' : '/dev/null';
  const added = await Promise.all(
    untracked.map(
      async (file) => (await git([...off, ...DIFF, '--no-index', '--', nothing, file], cwd)).stdout,
    ),
  );
  return splitDiff([tracked, ...added].join('\n'));
}

/** A git diff of several files, as each file's patch. */
export function splitDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { header: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const plus = current.lines.find((line) => line.startsWith('+++ '));
    const minus = current.lines.find((line) => line.startsWith('--- '));
    const named = (line: string | undefined) => {
      const name = line?.slice(4).trim();
      return name === undefined || name === '/dev/null' ? undefined : name.replace(/^[ab]\//, '');
    };
    const path =
      named(plus) ?? named(minus) ?? /^diff --git a\/(.+?) b\//.exec(current.header)?.[1] ?? '';
    files.push({ path, patch: [current.header, ...current.lines].join('\n') });
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = { header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return files;
}
