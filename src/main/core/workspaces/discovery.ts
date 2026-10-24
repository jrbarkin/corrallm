import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { GitError } from './git';
import type { GitRunner } from './git';
import { projectOwnedRoot } from './owned';
import type { RepositoryRecord, WorkspaceStore } from './store';

/*
 * Safe repository discovery (B9a Design §2, Repository discovery and authority). Given the project
 * folder a person picked (a TrustedPath, never a renderer's path), finds the checkout it is: its
 * real top level, its own and common Git directories, an identity for the repository, its HEAD, and
 * the filter drivers configured in it. It refuses, saying why, what isn't exactly the folder picked
 * (a folder inside a repository, a `.git` that is a symlink or a file naming another checkout, a
 * `core.worktree` redirect, a registration that doesn't agree), what can't be checked out safely
 * (configuration the runner can't neutralize), and a repository with no commit to start from. A
 * failure to read a repository is never taken for a folder that isn't one: only Git's own "not a
 * git repository", with no `.git` there at all, is.
 */

/** A checkout found: the picked folder's real top level and what identifies its repository. */
export interface FoundRepository {
  /** As picked, and its real path (its top level). */
  pickedRoot: string;
  realRoot: string;
  /** Its own Git directory (a linked worktree's is under the common one), and the common one. */
  gitDir: string;
  commonDir: string;
  identity: string;
  /** Where it is: its branch (none: detached) and commit. */
  head: { ref: string | null; oid: string };
  /** The filter drivers configured in it, which every call there disables. */
  drivers: string[];
}

/** Why a picked folder can't have workspaces made of it. */
export type DiscoveryRefusal =
  /** No git, or one too old. */
  | 'git-missing'
  | 'git-unsupported'
  /** Git couldn't be run, or failed, or took too long. */
  | 'git-failed'
  /** The folder isn't there, or can't be read. */
  | 'missing'
  | 'inaccessible'
  /** A folder inside a repository, not its top level: never widened to the whole repository. */
  | 'subdirectory'
  /** A checkout that is really somewhere else. */
  | 'redirected'
  /** A bare repository, a submodule's checkout, a `.git` Git can't read, a path it can't keep. */
  | 'unsupported'
  /** Configuration the runner can't neutralize. */
  | 'config'
  /** A repository with no commit to start a workspace from. */
  | 'no-commit';

export type Discovery =
  | { kind: 'repository'; repository: FoundRepository }
  /** A folder that genuinely isn't a repository: its agents share it, as before. */
  | { kind: 'not-git' }
  | { kind: 'refused'; reason: DiscoveryRefusal; sentence: string };

/** A worktree Git has registered, as `git worktree list --porcelain -z` says. */
export interface Registration {
  path: string;
  head: string | null;
  /** Its branch's full ref; none if detached. */
  branch: string | null;
  bare: boolean;
  /** Why it is locked, if it is ('' for no reason given). */
  locked: string | null;
  prunable: boolean;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A `.git` file, and a worktree's back-pointer, are a line. */
const MAX_POINTER_BYTES = 4096;

/**
 * What identifies a repository beside its path: its common Git directory's inode and object
 * format, so a repository made again where one was (deleted and cloned again) is another.
 */
export function repositoryIdentity(commonDir: string, objectFormat: string): string {
  const { ino } = statSync(commonDir, { bigint: true });
  return `git ${objectFormat} common-dir inode ${ino.toString()}`;
}

/** The worktrees `git worktree list --porcelain -z` printed. */
export function registrations(stdout: string): Registration[] {
  const found: Registration[] = [];
  let current: Registration | undefined;
  for (const field of stdout.split('\0')) {
    if (field === '') {
      if (current !== undefined) found.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current !== undefined) found.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        locked: null,
        prunable: false,
      };
    } else if (current !== undefined) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'bare') current.bare = true;
      else if (key === 'locked') current.locked = value;
      else if (key === 'prunable') current.prunable = true;
    }
  }
  if (current !== undefined) found.push(current);
  return found;
}

/** The real path of `file`, or none if it can't be resolved. */
export function realOrNone(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/** A small regular file's text (never through a symlink), or none if it isn't one. */
export function pointer(file: string): string | undefined {
  try {
    const found = lstatSync(file);
    if (!found.isFile() || found.size > MAX_POINTER_BYTES) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The Git directory a `.git` file names, resolved from the folder it is in. */
export function gitdirOf(dotGit: string): string | undefined {
  const text = pointer(dotGit);
  const named = text === undefined ? undefined : /^gitdir: (.+?)\r?\n?$/.exec(text)?.[1];
  return named === undefined ? undefined : path.resolve(path.dirname(dotGit), named);
}

/**
 * Whether `gitDir` is a linked worktree's registration in `commonDir` whose back-pointer names
 * `checkout`'s `.git`: the two agree, as Git's own repair would check.
 */
export function agrees(checkout: string, gitDir: string, commonDir: string): boolean {
  const real = realOrNone(gitDir);
  if (real === undefined || path.dirname(real) !== path.join(commonDir, 'worktrees')) return false;
  const back = pointer(path.join(real, 'gitdir'))?.trim();
  if (back === undefined || back === '') return false;
  const named = path.resolve(real, back);
  return path.basename(named) === '.git' && realOrNone(path.dirname(named)) === checkout;
}

/**
 * Within a write: keeps the repository found, by its real path and identity. One kept already is
 * found again (its picked path and common directory as they are now; its generation moves on if
 * either changed), its workspaces' folder never moved; a new one (`id`) gets this profile's folder
 * inside its checkout.
 */
export function recordRepository(
  workspaces: WorkspaceStore,
  found: FoundRepository,
  { profile, id }: { profile: string; id: string },
): RepositoryRecord {
  const kept = workspaces.repositoryAt(found.realRoot, found.identity);
  if (kept !== undefined) {
    return workspaces.rediscovered(kept.id, {
      pickedRoot: found.pickedRoot,
      commonDir: found.commonDir,
    });
  }
  return workspaces.addRepository({
    id,
    pickedRoot: found.pickedRoot,
    realRoot: found.realRoot,
    commonDir: found.commonDir,
    identity: found.identity,
    rootKind: 'project',
    ownedRoot: projectOwnedRoot(found.realRoot, profile),
  });
}

function refuse(reason: DiscoveryRefusal, sentence: string): Discovery {
  return { kind: 'refused', reason, sentence };
}

function gitRefusal(error: unknown): Discovery {
  if (!(error instanceof GitError)) throw error;
  if (error.fault === 'git-missing') {
    return refuse(
      'git-missing',
      'Git isn’t installed, so agents can’t get worktrees of their own.',
    );
  }
  if (error.fault === 'git-unsupported') return refuse('git-unsupported', error.message);
  if (error.fault === 'config') return refuse('config', error.message);
  return refuse('git-failed', `Git couldn’t read the project folder: ${firstLine(error)}`);
}

function firstLine(error: GitError): string {
  return (error.stderr.split('\n').find((line) => line.trim() !== '') ?? error.message).trim();
}

/** Discovers the checkout `picked` is, as Git and the file system both say. */
export async function discoverRepository(git: GitRunner, picked: string): Promise<Discovery> {
  let realRoot: string;
  try {
    realRoot = realpathSync(picked);
    if (!statSync(realRoot).isDirectory()) {
      return refuse('missing', 'The project folder isn’t a folder.');
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? refuse('missing', 'The project folder is missing.')
      : refuse('inaccessible', 'The project folder can’t be read.');
  }
  if (CONTROL.test(realRoot)) {
    return refuse('unsupported', 'The project folder’s path has control characters in it.');
  }
  const dotGitPath = path.join(realRoot, '.git');
  let dotGit: 'none' | 'folder' | 'file';
  try {
    const found = lstatSync(dotGitPath);
    if (found.isSymbolicLink()) {
      return refuse('redirected', 'Its .git is a symlink to somewhere else.');
    }
    if (found.isDirectory()) dotGit = 'folder';
    else if (found.isFile()) dotGit = 'file';
    else return refuse('unsupported', 'Its .git is neither a folder nor a file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return refuse('inaccessible', 'Its .git can’t be read.');
    }
    dotGit = 'none';
  }

  let lines: string[];
  try {
    const { stdout } = await git.run({
      cwd: realRoot,
      args: [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
        '--show-object-format',
      ],
    });
    lines = stdout.split('\n');
  } catch (error) {
    if (
      error instanceof GitError &&
      error.fault === 'failed' &&
      /^fatal: not a git repository/m.test(error.stderr)
    ) {
      return dotGit === 'none'
        ? { kind: 'not-git' }
        : refuse('unsupported', 'Its .git isn’t a repository Git can read.');
    }
    if (error instanceof GitError && error.fault === 'failed') {
      return refuse('inaccessible', `Git refuses this repository: ${firstLine(error)}`);
    }
    return gitRefusal(error);
  }
  const [toplevel = '', gitDirText = '', commonDirText = '', objectFormat = ''] = lines;
  const top = realOrNone(toplevel);
  if (dotGit === 'none') {
    return top !== undefined && top !== realRoot
      ? refuse(
          'subdirectory',
          `This folder is inside the Git repository at ${top}. Choose that folder to give each agent a worktree of its own.`,
        )
      : refuse('redirected', 'Git finds this checkout through another folder.');
  }
  if (top !== realRoot) {
    return refuse('redirected', 'Git says this checkout’s top level is another folder.');
  }
  const gitDir = realOrNone(gitDirText);
  const commonDir = realOrNone(commonDirText);
  if (gitDir === undefined || commonDir === undefined || !/^sha(?:1|256)$/.test(objectFormat)) {
    return refuse('unsupported', 'Git’s directories for this checkout can’t be found.');
  }

  let drivers: string[];
  try {
    const inspected = await git.inspect(realRoot);
    if (inspected.refusals.some((refusal) => refusal.startsWith('core.worktree'))) {
      return refuse(
        'redirected',
        'Its configuration sets core.worktree, redirecting the checkout.',
      );
    }
    if (inspected.refusals.length > 0) {
      return refuse(
        'config',
        `Its Git configuration can’t be made safe to check out: ${inspected.refusals.join(' ')}`,
      );
    }
    drivers = inspected.drivers;
  } catch (error) {
    return gitRefusal(error);
  }

  if (dotGit === 'folder') {
    if (gitDir !== path.join(realRoot, '.git') || commonDir !== gitDir) {
      return refuse('redirected', 'Its .git folder isn’t the repository Git uses.');
    }
  } else {
    const named = gitdirOf(dotGitPath);
    if (named === undefined || realOrNone(named) !== gitDir) {
      return refuse('redirected', 'Its .git file names another repository.');
    }
    // A linked worktree's registration must name this checkout back. A .git file naming a whole
    // repository kept elsewhere (a forged one, or a submodule's, whose configuration also sets
    // core.worktree) is settled by the registration check below: Git registers its checkout there.
    if (gitDir !== commonDir && !agrees(realRoot, gitDir, commonDir)) {
      return refuse('redirected', 'Its .git file and the worktree Git registered don’t agree.');
    }
  }

  try {
    const listed = await git.run({
      cwd: realRoot,
      args: ['worktree', 'list', '--porcelain', '-z'],
      drivers,
    });
    if (
      !registrations(listed.stdout).some(
        (entry) => !entry.bare && realOrNone(entry.path) === realRoot,
      )
    ) {
      return refuse('redirected', 'Git hasn’t registered this folder as one of its checkouts.');
    }
    const head = await git.run({
      cwd: realRoot,
      args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      drivers,
      answers: [1],
    });
    const oid = head.stdout.trim();
    if (head.code !== 0) {
      return refuse('no-commit', 'Make the repository’s first commit, then retry.');
    }
    if (!OID.test(oid)) return refuse('unsupported', 'Its HEAD isn’t a commit Git names.');
    const branch = await git.run({
      cwd: realRoot,
      args: ['symbolic-ref', '--quiet', 'HEAD'],
      drivers,
      answers: [1],
    });
    const ref = branch.code === 0 ? branch.stdout.trim() : null;
    if (ref !== null && (!ref.startsWith('refs/') || CONTROL.test(ref))) {
      return refuse('unsupported', 'Its HEAD names a ref corrallm can’t keep.');
    }
    return {
      kind: 'repository',
      repository: {
        pickedRoot: picked,
        realRoot,
        gitDir,
        commonDir,
        identity: repositoryIdentity(commonDir, objectFormat),
        head: { ref, oid },
        drivers,
      },
    };
  } catch (error) {
    return gitRefusal(error);
  }
}
