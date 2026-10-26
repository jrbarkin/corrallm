import { accessSync, constants, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { SAFE_GIT_ENV, SAFE_GIT_OPTIONS, safeGitDiffArgs } from '../../git';
import { execFile } from '../../sessions/process';
import type { TemporaryIndex } from './merge-index';

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
 *   credential helper), no automatic gc or maintenance (which could prune, or detach from the
 *   core's process group), and worktrees registered by absolute paths (so `worktree add` never
 *   writes the repository's configuration to record relative ones). Each filter driver configured where a call runs (`inspect`) has its
 *   clean, smudge and process commands blanked and its required flag cleared: no filter runs, Git
 *   LFS's included. Patches (`patch`) also take safeGitDiffArgs: no external diff, textconv,
 *   signature program, or submodule's own programs.
 * - The environment is the agents' (their PATH and home), with every GIT_ variable removed, so
 *   none redirects a call (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE...) or configures it
 *   (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT...), then no prompt, SAFE_GIT_ENV (no lazy fetch, no
 *   transport whatever the repository allows: GIT_ALLOW_PROTOCOL), and C messages.
 * - Each call is bounded in time and output, and runs as a child the core owns (core/children.ts,
 *   through sessions/process.ts): recorded before it runs, its whole process group ended if it
 *   takes too long or says too much, and refused once the core is closing.
 * - B9b's merges add a profile (B9b Design §9 C7, C9): replace refs ignored, so an object id means
 *   the object itself; renormalization off (it runs filters inside a merge); every custom merge
 *   driver configured where the call runs blanked by name, so none runs and a path that needs one
 *   fails closed; Git 2.39 or later; and longer bounds. The install (`install`) is a fast-forward
 *   to a prepared commit with fixed flags that beat any the repository sets, and a commit
 *   (`commitTree`) is never signed and never opens an editor. A diff's pages read through
 *   `capped`, which ends a git at its byte cap and answers what it read, cut. A checkpoint's
 *   temporary index (`index`) is only ever one the merge service made (merge-index.ts).
 *
 * What this protects is the core running a repository's programs itself. A worktree is checkout
 * isolation, not a sandbox: agents run their own commands in it, and a process already running as
 * the user can change a repository's configuration whenever it likes.
 */

/** A version of Git: its major and minor numbers. */
export type GitVersion = readonly [number, number];

/** The oldest Git it runs: `worktree list --porcelain -z` (2.36) reads paths of any shape. */
export const MIN_GIT_VERSION: GitVersion = [2, 36];

/**
 * The oldest Git it merges with (B9b Design §9.1): `merge-tree --write-tree` came in 2.38, and
 * 2.39 (Debian bookworm's) is the oldest the merge is tested on. Every call of the merge profile
 * needs it; worktrees and Review changes still run from MIN_GIT_VERSION.
 */
export const MERGE_GIT_VERSION: GitVersion = [2, 39];

/** How long computing a merge, or preparing its commits, may take: a timeout refuses it. */
export const MERGE_TIMEOUT_MS = 5 * 60 * 1000;
/** How long the install may take (the merge service holds a job a timeout or crash ends there). */
export const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

/** An object's id, as Git names it in a SHA-1 or a SHA-256 repository. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The longest message a merge's commit takes, in UTF-8 bytes. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** The longest name or email of a commit's author or committer, in UTF-8 bytes. */
const MAX_IDENTITY_BYTES = 256;

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
  /** Configuration for this call alone (`name=value` each); the fixed options still win over it. */
  config?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Exit codes that answer rather than fail (Git's 1 for "there is none"). */
  answers?: readonly number[];
  /**
   * The oldest Git the call needs, when newer than MIN_GIT_VERSION: an older one refuses it
   * (`git-unsupported`) before anything runs.
   */
  needs?: GitVersion;
  /**
   * Replace refs ignored (`git --no-replace-objects`): an object id names the object itself,
   * whatever `refs/replace/` says, so what Review changes reads is what merges. The merge profile
   * implies it.
   */
  noReplaceObjects?: boolean;
  /** B9b's merge profile, on every call that computes, prepares or installs a merge. */
  merge?: MergeProfile;
  /**
   * The index Git reads and writes (GIT_INDEX_FILE): only a temporary index the merge service
   * made for its job (merge-index.ts), never the environment's or a caller's path.
   */
  index?: TemporaryIndex;
}

/**
 * What a call computing, preparing or installing a merge adds (B9b Design §9 C7, C9): replace refs
 * ignored; renormalization off, since it runs clean and smudge filters inside a merge; and each
 * custom merge driver configured where it runs blanked (`merge.<name>.driver=`), so none runs and a
 * path that needs one fails closed, a conflict or Git stopping, never merged some other way. Its
 * calls need MERGE_GIT_VERSION and are bounded by MERGE_TIMEOUT_MS unless they say otherwise.
 */
export interface MergeProfile {
  /** Every custom merge driver configured where the call runs (`inspect`'s `mergeDrivers`). */
  drivers: readonly string[];
}

/** Who a commit is by: a name and an email, as `-c author.*` and `-c committer.*` give them. */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * What a capped read answers: what Git printed, whole (`cut` false, with its exit code), or its
 * first bytes up to the cap, ending at a whole character (`cut` true: Git was ended, so no code).
 */
export interface CappedOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  cut: boolean;
}

/** What a repository's configuration is, where a call runs. */
export interface ConfigInspection {
  /** Every filter driver configured there, includes and conditional includes as they apply. */
  drivers: string[];
  /**
   * Every custom merge driver configured there (`merge.<name>.driver`), likewise: a merge's calls
   * blank each, and refuse one `-c` can't name.
   */
  mergeDrivers: string[];
  /** What can't be neutralized there (none: everything can). */
  refusals: string[];
}

/**
 * The agents' environment without any of Git's own variables, then the runner's, SAFE_GIT_ENV's
 * among them. Its GIT_ALLOW_PROTOCOL is the only transport policy Git puts above every
 * configuration: a repository's `protocol.<name>.allow` outranks `protocol.allow=never`, and
 * `ext::` would then run a command (a partial clone's lazy fetch reaches it on a Git that doesn't
 * know GIT_NO_LAZY_FETCH). Its empty allowlist admits no transport, including external remote helpers.
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
    ...SAFE_GIT_ENV,
    LC_ALL: 'C',
  };
}

export class GitRunner {
  readonly #deps: GitRunnerDeps;
  readonly #platform: NodeJS.Platform;
  /** Each executable's version, asked once. */
  readonly #versions = new Map<string, Promise<AskedVersion>>();

  constructor(deps: GitRunnerDeps) {
    this.#deps = deps;
    this.#platform = deps.platform ?? process.platform;
  }

  /** Runs `git <fixed options> <drivers disabled> <merge profile> <args>` in `cwd`. */
  async run(call: GitCall): Promise<GitOutput> {
    const { git, args, env } = await this.#prepare(call);
    return this.#exec(git, args, env, { ...call, timeoutMs: timeoutOf(call) });
  }

  /**
   * Runs a call as `run` does, reading what it prints up to `cap` bytes: past them, its process
   * group is ended and it answers what it read, cut at a whole character (B9b §9 C2's pages, which
   * cut further at a line). Never a larger buffer read whole and then cut, and never a git that
   * failed, timed out or said too much on stderr read as a short page: those fail as `run`'s do.
   */
  async capped(call: GitCall & { cap: number }): Promise<CappedOutput> {
    const { cap, ...rest } = call;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new TypeError(`${String(cap)} isn’t a cap.`);
    const { git, args, env } = await this.#prepare(rest);
    return this.#exec(git, args, env, { ...rest, timeoutMs: timeoutOf(rest), maxBytes: cap }, cap);
  }

  /**
   * Installs the prepared merge commit `commit` (an object id) in the checkout at `cwd` (B9b
   * Design §9 C8): a fast-forward, `merge --ff-only --no-overwrite-ignore`, which computes no
   * merge, refuses a file in the way, an ignored one too, and writes nothing then but ORIG_HEAD;
   * with flags that beat any the repository sets (`branch.<name>.mergeOptions`, `merge.*`): no
   * signature verified, no autostash, no diffstat, no squash, no editor. Under the merge profile,
   * bounded by INSTALL_TIMEOUT_MS.
   */
  async install(call: {
    cwd: string;
    commit: string;
    drivers?: readonly string[];
    merge: MergeProfile;
    timeoutMs?: number;
  }): Promise<GitOutput> {
    if (!OID.test(call.commit)) throw new TypeError(`${call.commit} isn’t a commit’s object id.`);
    return this.run({
      cwd: call.cwd,
      ...(call.drivers === undefined ? {} : { drivers: call.drivers }),
      merge: call.merge,
      timeoutMs: call.timeoutMs ?? INSTALL_TIMEOUT_MS,
      args: [
        'merge',
        '--ff-only',
        '--no-overwrite-ignore',
        '--no-verify-signatures',
        '--no-autostash',
        '--no-stat',
        '--no-squash',
        '--no-edit',
        '-q',
        call.commit,
      ],
    });
  }

  /**
   * Makes a commit of `tree` on `parents` (object ids, one or two) with `message`, by `author`
   * and `committer` as given, under the merge profile (B9b Design §9 C6, C9e): never signed
   * (`commit.gpgSign=false`, `--no-gpg-sign`), never an editor (`-m`), and plumbing, so no
   * commit hook. Its id, checked to be one.
   */
  async commitTree(call: {
    cwd: string;
    tree: string;
    parents: readonly string[];
    message: string;
    author: GitIdentity;
    committer: GitIdentity;
    drivers?: readonly string[];
    merge: MergeProfile;
    timeoutMs?: number;
  }): Promise<string> {
    const { tree, parents, message, author, committer } = call;
    if (!OID.test(tree)) throw new TypeError(`${tree} isn’t a tree’s object id.`);
    if (parents.length < 1 || parents.length > 2 || !parents.every((one) => OID.test(one))) {
      throw new TypeError('A merge’s commit has one or two parents, by their object ids.');
    }
    if (
      message === '' ||
      message.includes('\0') ||
      Buffer.byteLength(message) > MAX_MESSAGE_BYTES
    ) {
      throw new TypeError('A commit’s message is some text, with no NUL, of at most 64 KiB.');
    }
    for (const who of [author, committer]) {
      for (const part of [who.name, who.email]) {
        if (
          part === '' ||
          Buffer.byteLength(part) > MAX_IDENTITY_BYTES ||
          /[<>\p{Cc}]/u.test(part)
        ) {
          throw new TypeError(`${JSON.stringify(part)} can’t be a commit’s name or email.`);
        }
      }
    }
    const { stdout } = await this.run({
      cwd: call.cwd,
      ...(call.drivers === undefined ? {} : { drivers: call.drivers }),
      ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
      merge: call.merge,
      config: [
        `author.name=${author.name}`,
        `author.email=${author.email}`,
        `committer.name=${committer.name}`,
        `committer.email=${committer.email}`,
      ],
      args: [
        '-c',
        'commit.gpgSign=false',
        'commit-tree',
        '--no-gpg-sign',
        ...parents.flatMap((parent) => ['-p', parent]),
        '-m',
        message,
        tree,
      ],
    });
    const oid = stdout.trim();
    if (!OID.test(oid)) {
      throw new GitError('failed', 'git commit-tree answered what isn’t an object id.');
    }
    return oid;
  }

  /**
   * A call's git, arguments and environment, once everything it needs is checked: the drivers
   * named, its Git found and new enough, the hooks folder empty, its index one of the merge
   * service's.
   */
  async #prepare(
    call: GitCall,
  ): Promise<{ git: string; args: string[]; env: Record<string, string> }> {
    const drivers = [...new Set(call.drivers ?? [])].sort();
    const unnamed = drivers.find((driver) => driver.includes('='));
    if (unnamed !== undefined) {
      throw new GitError('config', `Git can’t be told to disable the filter driver ${unnamed}.`);
    }
    const mergeDrivers = [...new Set(call.merge?.drivers ?? [])].sort();
    const unnamedMerge = mergeDrivers.find((driver) => driver.includes('='));
    if (unnamedMerge !== undefined) {
      throw new GitError(
        'config',
        `Git can’t be told to disable the merge driver ${unnamedMerge}: merging is refused.`,
      );
    }
    const env = gitEnvironment(await this.#deps.environment());
    if (call.index !== undefined) {
      if (!path.isAbsolute(call.index)) throw new TypeError(`${call.index} isn’t absolute.`);
      env.GIT_INDEX_FILE = call.index;
    }
    const git = this.#deps.executable ?? findGit(env, this.#platform);
    if (git === undefined) throw new GitError('git-missing', 'Git isn’t installed.');
    this.#checkHooks();
    const version = await this.#version(git, env);
    floor(version, MIN_GIT_VERSION, 'Worktrees need');
    if (call.merge !== undefined) floor(version, MERGE_GIT_VERSION, 'Merging needs');
    if (call.needs !== undefined) floor(version, call.needs, 'This needs');
    const args = [
      // The call's own first: Git takes the last of each, so the fixed options win.
      ...(call.config ?? []).flatMap((entry) => ['-c', entry]),
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
      '-c',
      'worktree.useRelativePaths=false',
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
      ...(call.merge === undefined
        ? []
        : [
            '-c',
            'merge.renormalize=false',
            ...mergeDrivers.flatMap((driver) => ['-c', `merge.${driver}.driver=`]),
          ]),
      ...(call.merge !== undefined || call.noReplaceObjects === true
        ? ['--no-replace-objects']
        : []),
      ...call.args,
    ];
    return { git, args, env };
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
    const mergeDrivers = new Set<string>();
    const refusals = new Set<string>();
    for (const name of names) {
      // Kept even when -c can't name it (`=`): a merge's call refuses it, nothing else needs to.
      const merging = /^merge\.(.*)\.driver$/s.exec(name)?.[1];
      if (merging !== undefined) mergeDrivers.add(merging);
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
    return {
      drivers: [...drivers].sort(),
      mergeDrivers: [...mergeDrivers].sort(),
      refusals: [...refusals].sort(),
    };
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

  /** The version of `git`, asked once: what it says, and its numbers (0.0 for none it says). */
  #version(git: string, env: Record<string, string>): Promise<AskedVersion> {
    let asked = this.#versions.get(git);
    if (asked === undefined) {
      // Asked in the hooks folder: an empty folder of the core's, in no repository.
      asked = this.#exec(git, ['--version'], env, { cwd: this.#deps.hooks }).then(({ stdout }) => {
        const found = /^git version (\d+)\.(\d+)/.exec(stdout.trim());
        return {
          text: stdout.trim() || 'unknown',
          version: found ? [Number(found[1]), Number(found[2])] : [0, 0],
        };
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
  ): Promise<GitOutput>;
  #exec(
    git: string,
    args: readonly string[],
    env: Record<string, string>,
    call: Pick<GitCall, 'cwd' | 'timeoutMs' | 'maxBytes' | 'answers'>,
    cap: number,
  ): Promise<CappedOutput>;
  #exec(
    git: string,
    args: readonly string[],
    env: Record<string, string>,
    call: Pick<GitCall, 'cwd' | 'timeoutMs' | 'maxBytes' | 'answers'>,
    cap?: number,
  ): Promise<GitOutput | CappedOutput> {
    const answers = call.answers ?? [];
    const read = (code: number, stdout: string, stderr: string) =>
      cap === undefined ? { code, stdout, stderr } : { code, stdout, stderr, cut: false };
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
              resolve(read(0, stdout, stderr));
              return;
            }
            const code = (error as { code?: unknown }).code;
            if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              if (cap !== undefined && overflowed(error) === 'stdout') {
                resolve({ code: null, stdout: cutAt(stdout, cap), stderr, cut: true });
              } else {
                reject(new GitError('output', `git ${args.at(-1) ?? ''} printed too much.`));
              }
            } else if (typeof code === 'number' && answers.includes(code)) {
              resolve(read(code, stdout, stderr));
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

/** A version of Git as it says it, and its numbers. */
interface AskedVersion {
  text: string;
  version: GitVersion;
}

/** Throws `git-unsupported`, saying what `needing` does, unless `asked` is `least` or later. */
function floor(asked: AskedVersion, least: GitVersion, needing: string): void {
  const [major, minor] = least;
  const [has, hasMinor] = asked.version;
  if (has < major || (has === major && hasMinor < minor)) {
    throw new GitError(
      'git-unsupported',
      `${needing} Git ${String(major)}.${String(minor)} or later; this is ${asked.text}.`,
    );
  }
}

/** A call's bound in time: its own, else the merge profile's, else the default. */
function timeoutOf(call: GitCall): number {
  return call.timeoutMs ?? (call.merge === undefined ? DEFAULT_TIMEOUT_MS : MERGE_TIMEOUT_MS);
}

/** Which of a git's streams went past its bound: as the owned helper says it, or Node's execFile. */
function overflowed(error: Error): 'stdout' | 'stderr' {
  const stream = (error as { stream?: unknown }).stream;
  if (stream === 'stdout' || stream === 'stderr') return stream;
  return /\bstdout\b/.test(error.message) ? 'stdout' : 'stderr';
}

/**
 * `text` within `cap` bytes of UTF-8, ending at a whole character: a character the cap cut into
 * (or decoded as a replacement for its cut bytes) is left out with what follows.
 */
function cutAt(text: string, cap: number): string {
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(cap, bytes.length);
  // A continuation byte past the end means the character before it straddles the cut.
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const kept = bytes.subarray(0, end).toString('utf8');
  return kept.endsWith('\uFFFD') ? kept.slice(0, -1) : kept;
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
