import { accessSync, constants, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { SAFE_GIT_OPTIONS, safeGitDiffArgs } from '../../git';
import { execFile } from '../../sessions/process';

/*
 * The one runner every Git call of the workspaces goes through (B9a Design §2, Git execution
 * boundary): its making and checking of worktrees, and B9b's diffs and merges after it.
 *
 * - No shell: git is run by its absolute path, found only in the PATH's absolute folders (never
 *   one a repository could plant in the folder it runs in), with an argument list of the core's.
 * - Fixed options on every call keep a repository's programs from running: SAFE_GIT_OPTIONS (no
 *   fsmonitor, no implicit bare repository), an empty hooks folder of the core's own as
 *   core.hooksPath (no repository hook, wherever its configuration puts them), no recursion into
 *   submodules, no transport at all (no fetch, so no lazy fetch of a partial clone and no ssh or
 *   credential helper), and no automatic gc or maintenance (which could prune, or detach from the
 *   core's process group). Each filter driver configured where a call runs (`inspect`) has its
 *   clean, smudge and process commands blanked and its required flag cleared: no filter runs, Git
 *   LFS's included. Patches (`patch`) also take safeGitDiffArgs: no external diff, textconv,
 *   signature program, or submodule's own programs.
 * - The environment is the agents' (their PATH and home), with every GIT_ variable removed, so
 *   none redirects a call (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE...) or configures it
 *   (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT...), then no prompt, no lazy fetch, no transport
 *   whatever the repository allows (GIT_ALLOW_PROTOCOL), and C messages.
 * - Each call is bounded in time and output, and runs as a child the core owns (core/children.ts,
 *   through sessions/process.ts): recorded before it runs, its whole process group ended if it
 *   takes too long or says too much, and refused once the core is closing.
 *
 * What this protects is the core running a repository's programs itself. A worktree is checkout
 * isolation, not a sandbox: agents run their own commands in it, and a process already running as
 * the user can change a repository's configuration whenever it likes.
 */

/** The oldest Git it runs: `worktree list --porcelain -z` (2.36) reads paths of any shape. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 36];

/** How long a call may take, and how much it may print, unless it says otherwise. */
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** How much of what a failed git said is kept, for the core's diagnostics. */
const MAX_STDERR = 2000;
/** A repository's configuration listing may be longer than other output. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** Why a call didn't answer. */
export type GitFault =
  /** No git on the agents' PATH. */
  | 'git-missing'
  /** A git older than MIN_GIT_VERSION. */
  | 'git-unsupported'
  /** The core's hooks folder isn't an empty folder of its own: nothing runs until it is. */
  | 'hooks'
  /** A repository's configuration it can't neutralize (`inspect`'s refusals). */
  | 'config'
  /** The core's process owner refused to start it: the core is closing. */
  | 'refused'
  | 'timeout'
  | 'output'
  /** Git exited with a code the call didn't expect, or couldn't be started. */
  | 'failed';

export class GitError extends Error {
  readonly fault: GitFault;
  /** Git's exit code, if it exited. */
  readonly exitCode: number | null;
  /** What it said, bounded: never shown to a token or an agent. */
  readonly stderr: string;
  constructor(fault: GitFault, message: string, exitCode: number | null = null, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.fault = fault;
    this.exitCode = exitCode;
    this.stderr = stderr.slice(0, MAX_STDERR);
  }
}

export interface GitRunnerDeps {
  /** The agents' environment: where git is found (its PATH), and the user's home. */
  environment: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** The core's process owner (core/children.ts): every git is a child it records and ends. */
  processes?: { run<T>(work: () => T): T };
  /** A folder of the core's own, kept empty: every call's hooks folder. Made if missing. */
  hooks: string;
  /** Tests: the git to run, by its absolute path, instead of the one on the PATH. */
  executable?: string;
  platform?: NodeJS.Platform;
}

export interface GitCall {
  cwd: string;
  args: readonly string[];
  /** The filter drivers configured where it runs (`inspect`): each one's programs disabled. */
  drivers?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Exit codes that answer rather than fail (Git's 1 for "there is none"). */
  answers?: readonly number[];
}

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** What a repository's configuration is, where a call runs. */
export interface ConfigInspection {
  /** Every filter driver configured there, includes and conditional includes as they apply. */
  drivers: string[];
  /** What can't be neutralized there (none: everything can). */
  refusals: string[];
}

/**
 * The agents' environment without any of Git's own variables, then the runner's. GIT_ALLOW_PROTOCOL
 * is the only transport policy Git puts above every configuration: a repository's
 * `protocol.<name>.allow` outranks `protocol.allow=never`, and `ext::` would then run a command (a
 * partial clone's lazy fetch reaches it on a Git that doesn't know GIT_NO_LAZY_FETCH). Its list
 * names no transport Git has.
 */
export function gitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !/^GIT_/i.test(entry[0]),
  );
  return {
    ...Object.fromEntries(kept),
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: 'none',
    LC_ALL: 'C',
  };
}

export class GitRunner {
  readonly #deps: GitRunnerDeps;
  readonly #platform: NodeJS.Platform;
  /** Each executable's version, asked once. */
  readonly #versions = new Map<string, Promise<void>>();

  constructor(deps: GitRunnerDeps) {
    this.#deps = deps;
    this.#platform = deps.platform ?? process.platform;
  }

  /** Runs `git <fixed options> <drivers disabled> <args>` in `cwd`. */
  async run(call: GitCall): Promise<GitOutput> {
    const drivers = [...new Set(call.drivers ?? [])].sort();
    const unnamed = drivers.find((driver) => driver.includes('='));
    if (unnamed !== undefined) {
      throw new GitError('config', `Git can’t be told to disable the filter driver ${unnamed}.`);
    }
    const env = gitEnvironment(await this.#deps.environment());
    const git = this.#deps.executable ?? findGit(env, this.#platform);
    if (git === undefined) throw new GitError('git-missing', 'Git isn’t installed.');
    this.#checkHooks();
    await this.#version(git, env);
    const args = [
      ...SAFE_GIT_OPTIONS,
      '-c',
      `core.hooksPath=${this.#deps.hooks}`,
      '-c',
      'submodule.recurse=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      ...drivers.flatMap((driver) => [
        '-c',
        `filter.${driver}.clean=`,
        '-c',
        `filter.${driver}.smudge=`,
        '-c',
        `filter.${driver}.process=`,
        '-c',
        `filter.${driver}.required=false`,
      ]),
      ...call.args,
    ];
    return this.#exec(git, args, env, call);
  }

  /**
   * The repository's configuration where a call in `cwd` runs, as Git reads it there: its filter
   * drivers, and what can't be neutralized (a driver `-c` can't name, a `core.worktree` redirecting
   * the checkout, configured hooks, which core.hooksPath doesn't reach). A configuration Git can't
   * read fails the call: nothing is run on what couldn't be inspected.
   */
  async inspect(cwd: string): Promise<ConfigInspection> {
    const { stdout } = await this.run({
      cwd,
      args: ['config', '--list', '-z', '--name-only'],
      maxBytes: MAX_CONFIG_BYTES,
    });
    const names = stdout.split('\0').filter((name) => name !== '');
    const drivers = new Set<string>();
    const refusals = new Set<string>();
    for (const name of names) {
      const driver = /^filter\.(.*)\.(?:clean|smudge|process|required)$/s.exec(name)?.[1];
      if (driver !== undefined) {
        if (driver.includes('=')) {
          refusals.add(`The filter driver ${JSON.stringify(driver)} can’t be disabled.`);
        } else drivers.add(driver);
      }
      if (name === 'core.worktree') {
        refusals.add('core.worktree is set: it would redirect the checkout.');
      }
      if (name.startsWith('hook.')) {
        refusals.add(`Hooks are configured (${name}): core.hooksPath doesn’t disable them.`);
      }
    }
    return { drivers: [...drivers].sort(), refusals: [...refusals].sort() };
  }

  /**
   * A patch (diff, log or show), with safeGitDiffArgs: no external diff, textconv or filter
   * driver (`drivers`, from `inspect`) runs.
   */
  patch(
    call: Omit<GitCall, 'args'> & { command: 'diff' | 'log' | 'show'; args: readonly string[] },
  ): Promise<GitOutput> {
    const { command, args, drivers = [], ...rest } = call;
    let safe: string[];
    try {
      safe = safeGitDiffArgs(
        command,
        drivers.map((driver) => `filter.${driver}.clean`),
      );
    } catch (error) {
      return Promise.reject(new GitError('config', (error as Error).message));
    }
    return this.run({ ...rest, drivers, args: [...safe, ...args] });
  }

  async #version(git: string, env: Record<string, string>): Promise<void> {
    let asked = this.#versions.get(git);
    if (asked === undefined) {
      // Asked in the hooks folder: an empty folder of the core's, in no repository.
      asked = this.#exec(git, ['--version'], env, { cwd: this.#deps.hooks }).then(({ stdout }) => {
        const found = /^git version (\d+)\.(\d+)/.exec(stdout.trim());
        const [major, minor] = MIN_GIT_VERSION;
        const [has, hasMinor] = found ? [Number(found[1]), Number(found[2])] : [0, 0];
        if (has < major || (has === major && hasMinor < minor)) {
          throw new GitError(
            'git-unsupported',
            `Worktrees need Git ${String(major)}.${String(minor)} or later; this is ${stdout.trim() || 'unknown'}.`,
          );
        }
      });
      this.#versions.set(git, asked);
      // A git that couldn't be asked is asked again next time.
      asked.catch(() => this.#versions.delete(git));
    }
    return asked;
  }

  /**
   * Before every call: the hooks folder (made, private, if it is missing) is a real folder, ours
   * alone, with nothing in it.
   */
  #checkHooks(): void {
    const hooks = this.#deps.hooks;
    let fault: string | undefined;
    try {
      mkdirSync(hooks, { recursive: true, mode: 0o700 });
      const found = lstatSync(hooks);
      if (found.isSymbolicLink() || !found.isDirectory()) fault = 'isn’t a folder';
      else if (this.#platform !== 'win32' && found.uid !== process.getuid?.()) fault = 'isn’t ours';
      else if (this.#platform !== 'win32' && (found.mode & 0o022) !== 0) {
        fault = 'may be written by others';
      } else if (readdirSync(hooks).length > 0) fault = 'isn’t empty';
    } catch (error) {
      fault = (error as Error).message;
    }
    if (fault !== undefined) {
      throw new GitError('hooks', `The core’s hooks folder ${hooks} ${fault}: Git isn’t run.`);
    }
  }

  #exec(
    git: string,
    args: readonly string[],
    env: Record<string, string>,
    call: Pick<GitCall, 'cwd' | 'timeoutMs' | 'maxBytes' | 'answers'>,
  ): Promise<GitOutput> {
    const answers = call.answers ?? [];
    return new Promise((resolve, reject) => {
      const start = () =>
        execFile(
          git,
          args,
          {
            cwd: call.cwd,
            env,
            timeout: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: call.maxBytes ?? DEFAULT_MAX_BYTES,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ code: 0, stdout, stderr });
              return;
            }
            const code = (error as { code?: unknown }).code;
            if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(new GitError('output', `git ${args.at(-1) ?? ''} printed too much.`));
            } else if (typeof code === 'number' && answers.includes(code)) {
              resolve({ code, stdout, stderr });
            } else if (typeof code === 'number') {
              reject(new GitError('failed', `git exited with ${String(code)}.`, code, stderr));
            } else if ((error as { killed?: unknown }).killed === true) {
              reject(new GitError('timeout', 'git took too long.'));
            } else if (code === 'ENOENT') {
              reject(new GitError('git-missing', 'Git isn’t installed.'));
            } else {
              reject(new GitError('failed', `git couldn’t run: ${error.message}`, null, stderr));
            }
          },
        );
      try {
        if (this.#deps.processes) this.#deps.processes.run(start);
        else start();
      } catch (error) {
        reject(new GitError('refused', `Git isn’t run: ${(error as Error).message}`));
      }
    });
  }
}

/** git in the PATH's absolute folders only: a relative entry (".") could find a repository's. */
function findGit(env: Record<string, string>, platform: NodeJS.Platform): string | undefined {
  const search =
    platform === 'win32'
      ? (Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '')
      : (env.PATH ?? '');
  const name = platform === 'win32' ? 'git.exe' : 'git';
  for (const folder of search.split(platform === 'win32' ? ';' : ':')) {
    if (!path.isAbsolute(folder)) continue;
    const file = path.join(folder, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}
